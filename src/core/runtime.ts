import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFile, realpath } from "node:fs/promises";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import { StateStore } from "./store.js";
import { validateInput, type AgentInput, type AgentReply, type UiAdapter } from "./contracts.js";
import type { DownloadStatusBackend } from "../integrations/moviepilot.js";

export interface RuntimeOptions {
  projectDir: string;
  dataDir: string;
  model: Model<Api>;
  backend?: DownloadStatusBackend;
  /** Allows the host to share a model runtime or tests to register Pi's faux provider. */
  modelRuntime?: ModelRuntime;
}

/** One long-lived service owns the state directory and all its Pi sessions. */
export class AgentRuntime {
  readonly store: StateStore;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly loader: DefaultResourceLoader;
  private readonly settings: SettingsManager;
  private readonly lockPath: string;
  private stopped = false;
  private closing?: Promise<void>;

  private constructor(private readonly options: RuntimeOptions) {
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.lockPath = join(options.dataDir, "runtime.lock");
    if (existsSync(this.lockPath)) {
      const owner = JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid: number; host: string };
      if (owner.host !== hostname()) throw new Error("State directory is owned by another host");
      let alive = true;
      try { process.kill(owner.pid, 0); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
        else throw error;
      }
      if (alive) throw new Error("Another Agent service already owns this state directory");
      unlinkSync(this.lockPath);
    }
    const lock = openSync(this.lockPath, "wx", 0o600);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname() }));
    closeSync(lock);
    try {
      this.store = new StateStore(options.dataDir);
      this.settings = SettingsManager.inMemory({
        compaction: { enabled: true }, retry: { enabled: false },
      });
      this.loader = new DefaultResourceLoader({
        cwd: options.projectDir,
        agentDir: join(options.dataDir, "pi"),
        settingsManager: this.settings,
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalSkillPaths: [join(options.projectDir, "skills")],
        systemPrompt: "You are a personal media assistant. Use the read_skill tool to load relevant skills. " +
          "Tools and user identity are supplied by the application. Report only observed business results. " +
          "The prototype has no download submission tools. A request-specific condition is not a future default.",
        // Pi's standard Skill section expects its built-in read tool. This host uses
        // a scoped reader, so advertise discovered names/descriptions explicitly.
        systemPromptOverride: base => `${base ?? ""}\n<available_skills>\n${this.loader.getSkills().skills
          .map(skill => `${skill.name}: ${skill.description}`).join("\n")}\n</available_skills>`,
      });
    } catch (error) { unlinkSync(this.lockPath); throw error; }
  }

  static async create(options: RuntimeOptions): Promise<AgentRuntime> {
    const runtime = new AgentRuntime({ ...options, projectDir: resolve(options.projectDir), dataDir: resolve(options.dataDir) });
    try { await runtime.loader.reload(); return runtime; }
    catch (error) { await runtime.close(); throw error; }
  }

  getSkillNames(): string[] { return this.loader.getSkills().skills.map(skill => skill.name); }

  private key(input: Pick<AgentInput, "userId" | "conversationId">): string {
    return JSON.stringify([input.userId, input.conversationId]);
  }

  private tools(userId: string): ToolDefinition[] {
    const skillSchema = Type.Object({ name: Type.String() });
    const readSkill: ToolDefinition<typeof skillSchema> = {
      name: "read_skill", label: "Read skill", description: "Read an advertised project Skill by its name.",
      parameters: skillSchema,
      execute: async (_id, { name }) => {
        const skill = this.loader.getSkills().skills.find(item => item.name === name);
        if (!skill) throw new Error("Unknown skill");
        const root = await realpath(join(this.options.projectDir, "skills"));
        const path = await realpath(skill.filePath);
        const rel = relative(root, path);
        if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
          throw new Error("Skill is outside the project skill directory");
        }
        return { content: [{ type: "text", text: await readFile(path, "utf8") }], details: { name } };
      },
    };
    const preferences: ToolDefinition = {
      name: "get_preferences", label: "Get preferences", description: "Read the authenticated user's saved future defaults.",
      parameters: Type.Object({}),
      execute: async () => {
        const result = this.store.getPreferences(userId);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    };
    const downloading: ToolDefinition = {
      name: "get_downloading", label: "Downloading", description: "Read active MoviePilot downloads. This is not a completed-task or library list.",
      parameters: Type.Object({}),
      execute: async (_id, _params, signal) => {
        if (!this.options.backend) throw new Error("MoviePilot integration is not configured");
        const result = await this.options.backend.getDownloading(signal);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: { tasks: result } };
      },
    };
    return [readSkill, preferences, downloading];
  }

  private async session(input: AgentInput): Promise<AgentSession> {
    const key = this.key(input);
    const existing = this.sessions.get(key);
    if (existing) return existing;
    const digest = createHash("sha256").update(key).digest("hex");
    const sessionDir = join(this.options.dataDir, "sessions", digest);
    const saved = this.store.getSessionFile(input.userId, input.conversationId);
    if (saved && !existsSync(saved)) throw new Error("Saved Pi session is missing; restore it or start a new conversation");
    const manager = saved ? SessionManager.open(saved) : SessionManager.create(this.options.projectDir, sessionDir);
    const modelRuntime = this.options.modelRuntime ?? await ModelRuntime.create({
      authPath: join(this.options.dataDir, "pi", "auth.json"),
      modelsPath: join(this.options.dataDir, "pi", "models.json"),
    });
    const tools = this.tools(input.userId);
    const { session } = await createAgentSession({
      cwd: this.options.projectDir, agentDir: join(this.options.dataDir, "pi"),
      model: this.options.model, modelRuntime, thinkingLevel: "off", sessionManager: manager,
      settingsManager: this.settings, resourceLoader: this.loader,
      tools: tools.map(tool => tool.name), customTools: tools,
    });
    session.agent.toolExecution = "sequential";
    const file = manager.getSessionFile();
    if (!file) { session.dispose(); throw new Error("Pi did not create a persistent session path"); }
    this.store.setSessionFile(input.userId, input.conversationId, file);
    this.sessions.set(key, session);
    return session;
  }

  handle(input: AgentInput, adapter?: UiAdapter): Promise<AgentReply> {
    validateInput(input);
    if (this.stopped) return Promise.reject(new Error("Agent service is stopping"));
    const key = this.key(input);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      if (this.stopped) throw new Error("Agent service is stopping");
      const saved = this.store.getRequest(input);
      if (saved?.status === "done" && saved.reply) return saved.reply;
      if (saved) throw new Error("Previous delivery was interrupted; review the task before sending a new request");
      // Initialization is outside the request: failure here has not consumed user input.
      const session = await this.session(input);
      if (this.stopped) throw new Error("Agent service is stopping");
      this.store.beginRequest(input);
      const publish = (event: Parameters<UiAdapter["publish"]>[1]) => {
        // A UI disconnect must not corrupt the authoritative Agent run.
        try { adapter?.publish(input, event); } catch { /* final reply remains persisted */ }
      };
      const unsubscribe = session.subscribe(event => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          publish({ type: "text_delta", text: event.assistantMessageEvent.delta });
        } else if (event.type === "tool_execution_start") {
          publish({ type: "tool_start", name: event.toolName });
        } else if (event.type === "tool_execution_end") {
          publish({ type: "tool_end", name: event.toolName, failed: event.isError });
        }
      });
      try {
        await session.prompt(input.text);
        const last = [...session.messages].reverse().find(message => message.role === "assistant");
        if (!last || last.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
          throw new Error("Model run did not complete successfully");
        }
        const reply: AgentReply = { conversationId: input.conversationId, requestId: input.requestId,
          text: session.getLastAssistantText() ?? "" };
        this.store.finishRequest(input, reply);
        return reply;
      } catch (error) { this.store.interruptRequest(input); throw error; }
      finally { unsubscribe(); }
    });
    this.queues.set(key, work);
    void work.finally(() => { if (this.queues.get(key) === work) this.queues.delete(key); }).catch(() => undefined);
    return work;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = (async () => {
      await Promise.allSettled([...this.sessions.values()].map(session => session.abort()));
      await Promise.allSettled([...this.queues.values()]);
      for (const session of this.sessions.values()) session.dispose();
      this.sessions.clear();
      this.store.close();
      unlinkSync(this.lockPath);
    })();
    return this.closing;
  }
}
