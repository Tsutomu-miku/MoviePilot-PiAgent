import { resolve, join } from "node:path";
import {
  DefaultResourceLoader,
  ModelRuntime,
  SettingsManager,
  type AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  messageInputSchema,
  applyTranscriptEvent,
  type AgentInput,
  type AgentReply,
  type UiAdapter,
  type UiEvent,
  type UserAction,
  type View,
  type TranscriptBlock,
  type DisplayMessage,
} from "@mp-pi/contracts";
import { StateStore } from "./store.js";
import { ConflictError } from "./errors.js";
import { finalizeReplyViews } from "./reply-views.js";
import { systemPrompt } from "./system-prompt.js";
import { ConversationQueue } from "./queue.js";
import { conversationHistory } from "./history.js";
import { SessionPool, conversationKey } from "./sessions.js";
import { toolContext } from "./tools.js";
import { createTools } from "../capabilities/index.js";
import type { ToolContext } from "../domain/types.js";
import { publicTask } from "../domain/types.js";
import { isConfirmation } from "../domain/confirmation.js";
import type { MediaBackend } from "../integrations/moviepilot.js";
import { SearchService } from "../services/search-service.js";
import { TaskService } from "../services/task-service.js";
import { TransferService } from "../services/transfer-service.js";
import { SkillService } from "../services/skill-service.js";
import { MikanSearchService } from "../services/mikan-search-service.js";
import type { Identity } from "../domain/types.js";

export interface RuntimeOptions {
  projectDir: string;
  dataDir: string;
  model: Model<Api>;
  backend: MediaBackend;
  modelRuntime: ModelRuntime;
  onError(error: unknown): void;
}

export class AgentRuntime {
  readonly store: StateStore;
  readonly search: SearchService;
  readonly tasks: TaskService;
  readonly transfers: TransferService;
  readonly skills: SkillService;
  readonly mikan: MikanSearchService;
  private readonly queue = new ConversationQueue();
  private readonly sessions: SessionPool;
  private readonly abort = new AbortController();
  private closing?: Promise<void>;

  private constructor(
    private readonly options: RuntimeOptions,
    store: StateStore,
    private readonly settings: SettingsManager,
  ) {
    this.store = store;
    this.skills = new SkillService(join(options.projectDir, "skills"), options.dataDir);
    this.search = new SearchService(store, options.backend);
    this.mikan = new MikanSearchService(store, options.backend);
    this.transfers = new TransferService(store, options.backend, this.search);
    this.tasks = new TaskService(store, options.backend, this.search, this.transfers, this.mikan);
    const tools = createTools({
      store,
      search: this.search,
      tasks: this.tasks,
      transfers: this.transfers,
      backend: options.backend,
      skills: this.skills,
      mikan: this.mikan,
    });
    this.sessions = new SessionPool({
      ...options,
      store,
      settings,
      tools,
      getLoader: (identity) => this.resourceLoader(identity),
      getSkillRevision: (userId) => this.skills.revision(userId),
      isBusy: (key) => this.queue.isBusy(key),
    });
  }

  static async create(options: RuntimeOptions): Promise<AgentRuntime> {
    const paths = {
      ...options,
      projectDir: resolve(options.projectDir),
      dataDir: resolve(options.dataDir),
    };
    const store = new StateStore(paths.dataDir, join(paths.projectDir, "migrations"));
    const settings = SettingsManager.inMemory({
      compaction: { enabled: true },
      retry: { enabled: false },
    });
    return new AgentRuntime(paths, store, settings);
  }

  private async resourceLoader(identity: Identity): Promise<DefaultResourceLoader> {
    const loader: DefaultResourceLoader = new DefaultResourceLoader({
      cwd: this.options.projectDir,
      agentDir: join(this.options.dataDir, "pi"),
      settingsManager: this.settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      skillsOverride: () => this.skills.load(identity.userId),
      systemPrompt,
      systemPromptOverride: (base) =>
        `${base ?? ""}\n<available_skills>\n${loader
          .getSkills()
          .skills.filter((skill) => !skill.disableModelInvocation)
          .map((skill) => `${skill.name}: ${skill.description}`)
          .join("\n")}\n</available_skills>`,
    });
    await loader.reload();
    return loader;
  }

  getSkillNames(userId: string): string[] {
    return this.skills.load(userId).skills.map((skill) => skill.name);
  }

  getMessages(identity: Identity): DisplayMessage[] {
    return conversationHistory(this.store, identity);
  }

  handle(input: AgentInput, adapter?: UiAdapter): Promise<AgentReply> {
    if (this.closing) {
      return Promise.reject(new ConflictError("Agent 服务正在停止"));
    }
    messageInputSchema.parse({
      requestId: input.requestId,
      text: input.text,
      action: input.action,
      skillName: input.skillName,
    });
    this.store.getConversation(input);
    return this.queue.run(conversationKey(input), () => this.process(input, adapter));
  }

  private async action(action: UserAction, context: ToolContext): Promise<View> {
    const signal = this.abort.signal;
    switch (action.type) {
      case "mikan_search":
        return this.mikan.search(action.query, context, signal);
      case "prepare_mikan_download":
        return this.tasks.prepareMikanDownload(
          action.searchId,
          action.resourceIds,
          context,
          signal,
        );
      case "transfer_failures":
        return this.transfers.query(
          { title: action.title, page: action.page, count: 20 },
          context,
          signal,
        );
      case "prepare_transfer_retry":
        return this.tasks.prepareTransferRetry(action.searchId, action.historyIds, context, signal);
      case "resources":
        return this.search.searchResources(action.mediaKey, action.criteria ?? {}, context, signal);
      case "filter":
        return this.search.filter(action.searchId, action.criteria, context, signal);
      case "prepare_download":
        return this.tasks.prepareDownload(
          action.searchId,
          action.resourceId,
          action.destination,
          context,
          signal,
        );
      case "prepare_links":
        return this.tasks.prepareLinks(action.links, context, signal);
      case "confirm":
        context.approvedTaskIds.add(action.taskId);
        return this.tasks.confirm(action.taskId, action.token, context, signal);
      case "cancel": {
        const view = this.tasks.cancel(context, action.taskId);
        context.publish(view);
        return view;
      }
      case "subscribe":
        return this.tasks.prepareSubscription(action.mediaKey, action.season, context);
      case "subscription_change":
        return this.tasks.prepareSubscriptionChange(
          action.subscriptionId,
          action.operation,
          context,
          signal,
        );
    }
  }

  private approveText(input: AgentInput, context: ToolContext): void {
    if (!isConfirmation(input.text)) {
      return;
    }
    const pending = this.store
      .listTasks(input.userId, input.conversationId)
      .filter((task) => task.state === "awaiting_confirmation");
    if (pending.length === 1) {
      const task = pending[0]!;
      context.approvedTaskIds.add(task.id);
    }
  }

  private async process(input: AgentInput, adapter?: UiAdapter): Promise<AgentReply> {
    const saved = this.store.getRequest(input);
    let transcript: TranscriptBlock[] = [];
    const publish = (event: UiEvent) => {
      transcript = applyTranscriptEvent(transcript, event);
      try {
        adapter?.publish(input, event);
      } catch (error) {
        this.options.onError(error);
      }
    };
    if (saved?.status === "done" && saved.reply) {
      publish({ type: "reply", reply: saved.reply });
      return saved.reply;
    }
    if (saved) {
      throw new ConflictError("先前请求被中断，请核对任务状态后再发送新消息；不会重放该请求");
    }
    const views: View[] = [];
    const context: ToolContext = {
      ...input,
      inputText: input.text,
      approvedTaskIds: new Set(),
      publish: (view) => {
        views.push(view);
      },
    };
    this.approveText(input, context);
    const execution = input.action
      ? { kind: "action" as const, action: input.action }
      : { kind: "model" as const, session: await this.sessions.get(input) };
    this.abort.signal.throwIfAborted();
    this.store.beginRequest(input);
    this.store.addMessage(input, "user", input.text || "执行所选操作");
    let segment = 0;
    const unsubscribe =
      execution.kind === "model"
        ? execution.session.subscribe((event) => {
            if (event.type === "message_start" && event.message.role === "assistant") {
              segment += 1;
              publish({ type: "text_start" });
            } else if (event.type === "message_update") {
              const delta = event.assistantMessageEvent;
              if (delta.type === "text_start" || delta.type === "thinking_start") {
                publish({
                  type: "block_start",
                  block: {
                    id: `${input.requestId}:${segment}:${delta.contentIndex}`,
                    type: delta.type === "thinking_start" ? "thinking" : "text",
                    text: "",
                  },
                });
              } else if (delta.type === "text_delta" || delta.type === "thinking_delta") {
                publish({
                  type: "block_delta",
                  id: `${input.requestId}:${segment}:${delta.contentIndex}`,
                  text: delta.delta,
                });
                if (delta.type === "text_delta") {
                  publish({ type: "text_delta", text: delta.delta });
                }
              }
            } else if (event.type === "tool_execution_start") {
              publish({
                type: "tool_start",
                id: event.toolCallId,
                name: event.toolName,
                input: JSON.stringify(event.args, null, 2),
              });
            } else if (event.type === "tool_execution_end") {
              const result = event.result as AgentToolResult<unknown>;
              publish({
                type: "tool_end",
                id: event.toolCallId,
                name: event.toolName,
                failed: event.isError,
                output: result.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n"),
              });
            }
          })
        : undefined;
    try {
      let text: string;
      if (execution.kind === "action") {
        await this.action(execution.action, context);
        text = "操作结果如下。";
        await this.sessions.recordAction(
          input,
          `用户操作：${execution.action.type}\n执行结果：${JSON.stringify(views)}`,
        );
      } else {
        const session = execution.session;
        if (input.skillName) {
          this.skills.read(input.userId, input.skillName);
        }
        const prompt = input.skillName ? `/skill:${input.skillName} ${input.text}` : input.text;
        await toolContext.run(context, () => session.prompt(prompt));
        const last = [...session.messages]
          .reverse()
          .find((message) => message.role === "assistant");
        if (!last || last.stopReason === "error" || last.stopReason === "aborted") {
          throw new Error("模型请求未正常完成，请检查模型配置和服务日志");
        }
        text = session.getLastAssistantText() ?? "";
      }
      const reply: AgentReply = {
        conversationId: input.conversationId,
        requestId: input.requestId,
        text,
        transcript,
        views: finalizeReplyViews(
          views,
          this.store.listTasks(input.userId, input.conversationId).map(publicTask),
        ),
      };
      this.store.addMessage(input, "assistant", text, reply.views, transcript);
      this.store.finishRequest(input, reply);
      publish({ type: "reply", reply });
      return reply;
    } catch (error) {
      this.store.interruptRequest(input);
      const message = error instanceof Error ? error.message : "请求失败，请检查服务日志";
      transcript = transcript.map((block) =>
        block.type === "tool" && block.state === "running"
          ? { ...block, state: "failed", output: "执行中断，请核对任务状态。" }
          : block,
      );
      transcript.push({ id: `${input.requestId}:error`, type: "text", text: message });
      this.store.addMessage(
        input,
        "assistant",
        message,
        finalizeReplyViews(
          views,
          this.store.listTasks(input.userId, input.conversationId).map(publicTask),
        ),
        transcript,
      );
      publish({ type: "error", message });
      throw error;
    } finally {
      unsubscribe?.();
      this.sessions.persist(input);
    }
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      const drained = this.queue.close();
      this.abort.abort();
      await this.sessions.abort();
      await drained;
      this.sessions.dispose();
      this.store.close();
    })();
    return this.closing;
  }
}
