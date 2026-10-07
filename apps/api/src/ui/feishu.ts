import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type {
  LarkChannel,
  NormalizedMessage,
  CardActionEvent,
  EventMap,
} from "@larksuiteoapi/node-sdk";
import { actionSchema, stateLabels, type AgentInput } from "@mp-pi/contracts";
import { AgentRuntime } from "../core/runtime.js";
import { ConflictError } from "../core/errors.js";
import { ConversationQueue } from "../core/queue.js";
import type { Task } from "../domain/types.js";
import { EventBuffer } from "./event-buffer.js";
import { viewCard } from "./feishu-cards.js";

const cardValueSchema = z.strictObject({ conversationId: z.string().uuid(), action: actionSchema });
const cardTokenSchema = z.object({ token: z.string().min(1) });

export interface FeishuOptions {
  ownerId: string;
  allowedOpenIds: string[];
  allowedGroupIds: string[];
  onError(error: unknown): void;
}

export interface FeishuTransport
  extends Pick<LarkChannel, "connect" | "disconnect" | "send" | "stream"> {
  on(handlers: Partial<EventMap>): () => void;
}

export class FeishuUi {
  private unsubscribe?: () => void;
  private stopped = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly deliveries = new ConversationQueue();

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly channel: FeishuTransport,
    private readonly options: FeishuOptions,
  ) {}

  async start(): Promise<void> {
    this.unsubscribe = this.channel.on({
      message: (message) => this.dispatch(message.chatId, () => this.message(message)),
      cardAction: (event) => this.dispatch(event.chatId, () => this.cardAction(event)),
      error: this.options.onError,
    });
    await this.channel.connect();
  }

  private dispatch(chatId: string, operation: () => Promise<void>): void {
    if (this.stopped) {
      return;
    }
    const pending = this.deliveries
      .run(chatId, operation)
      .catch(this.options.onError)
      .finally(() => {
        this.pending.delete(pending);
      });
    this.pending.add(pending);
  }

  private checkSender(openId: string): void {
    if (!this.options.allowedOpenIds.includes(openId)) {
      throw new ConflictError("该飞书用户未授权使用 Agent");
    }
  }

  private checkChat(chatId: string, chatType: "p2p" | "group"): void {
    if (chatType === "group" && !this.options.allowedGroupIds.includes(chatId)) {
      throw new ConflictError("该飞书群未授权使用 Agent");
    }
  }

  private endpoint(chatId: string, senderId: string): string {
    return `feishu:${chatId}:${senderId}`;
  }

  private conversation(chatId: string, senderId: string): string {
    const endpoint = this.endpoint(chatId, senderId);
    const saved = this.runtime.store.getBinding(this.options.ownerId, endpoint);
    if (saved) {
      return saved;
    }
    const id = randomUUID();
    this.runtime.store.ensureConversation(
      { userId: this.options.ownerId, conversationId: id },
      "飞书会话",
      true,
    );
    this.runtime.store.setBinding(this.options.ownerId, endpoint, id);
    return id;
  }

  private async message(message: NormalizedMessage): Promise<void> {
    this.checkSender(message.senderId);
    this.checkChat(message.chatId, message.chatType);
    if (message.rawContentType !== "text" && message.rawContentType !== "post") {
      await this.channel.send(message.chatId, { text: "请使用文字或粘贴链接。" });
      return;
    }
    const endpoint = this.endpoint(message.chatId, message.senderId);
    const text = message.content.trim();
    if (text === "/new") {
      const id = randomUUID();
      this.runtime.store.ensureConversation(
        { userId: this.options.ownerId, conversationId: id },
        "飞书新会话",
        true,
      );
      this.runtime.store.setBinding(this.options.ownerId, endpoint, id);
      await this.channel.send(message.chatId, { text: `已创建新会话：${id}` });
      return;
    }
    if (text === "/sessions") {
      const conversations = this.runtime.store.listConversations(this.options.ownerId);
      await this.channel.send(message.chatId, {
        text:
          conversations
            .slice(0, 20)
            .map((item) => `${item.id}  ${item.title}`)
            .join("\n") || "尚无会话",
      });
      return;
    }
    if (text.startsWith("/use ")) {
      const id = z.string().uuid().parse(text.slice(5).trim());
      this.runtime.store.getConversation({ userId: this.options.ownerId, conversationId: id });
      this.runtime.store.setBinding(this.options.ownerId, endpoint, id);
      await this.channel.send(message.chatId, { text: `已切换会话：${id}` });
      return;
    }
    if (text === "/help") {
      await this.channel.send(message.chatId, {
        text: "/new 新建会话\n/sessions 会话列表\n/use <ID> 继续已有会话\n/tasks 查看任务\n/subscriptions 查看订阅\n其他消息直接交给 Agent。连续对话保持在当前会话中。",
      });
      return;
    }
    const input: AgentInput = {
      userId: this.options.ownerId,
      conversationId: this.conversation(message.chatId, message.senderId),
      requestId: message.messageId,
      text:
        text === "/tasks"
          ? "查看当前会话的任务"
          : text === "/subscriptions"
            ? "查看 MoviePilot 原生订阅"
            : text,
    };
    this.runtime.store.setFeishuRoute(input, {
      chatId: message.chatId,
      senderId: message.senderId,
      chatType: message.chatType,
    });
    await this.execute(input, message.chatId);
  }

  private async cardAction(event: CardActionEvent): Promise<void> {
    this.checkSender(event.operator.openId);
    const value = cardValueSchema.parse(event.action.value);
    const current = this.runtime.store.getBinding(
      this.options.ownerId,
      this.endpoint(event.chatId, event.operator.openId),
    );
    if (current !== value.conversationId) {
      await this.channel.send(event.chatId, {
        text: `这张卡片属于另一个会话，请先 /use ${value.conversationId} 后继续。`,
      });
      return;
    }
    const route = this.runtime.store.getFeishuRoute({
      userId: this.options.ownerId,
      conversationId: value.conversationId,
    });
    if (!route || route.chatId !== event.chatId) {
      throw new ConflictError("请先在当前会话发送一条消息，再使用卡片");
    }
    this.checkChat(route.chatId, route.chatType);
    const token = cardTokenSchema.parse(event.raw).token;
    const requestId = `card:${createHash("sha256").update(token).digest("hex")}`;
    const input: AgentInput = {
      userId: this.options.ownerId,
      conversationId: value.conversationId,
      requestId,
      text: "执行卡片所选操作",
      action: value.action,
    };
    this.runtime.store.setFeishuRoute(input, {
      chatId: event.chatId,
      senderId: event.operator.openId,
      chatType: route.chatType,
    });
    await this.execute(input, event.chatId);
  }

  private async execute(input: AgentInput, chatId: string): Promise<void> {
    const buffer = new EventBuffer();
    const result = this.runtime.handle(input, { publish: (_input, event) => buffer.push(event) });
    const completed = result.then(
      (reply) => {
        buffer.close();
        return { reply };
      },
      (error) => {
        buffer.close();
        return { error };
      },
    );
    try {
      const sent = await this.channel.stream(chatId, {
        markdown: async (controller) => {
          let streamed = false;
          for await (const event of buffer.read()) {
            if (event.type === "text_start") {
              streamed = false;
              await controller.setContent("正在处理你的请求…");
            } else if (event.type === "text_delta") {
              if (streamed) {
                await controller.append(event.text);
              } else {
                await controller.setContent(event.text);
              }
              streamed = true;
            } else if (event.type === "reply") {
              await controller.setContent(event.reply.text || "操作结果如下。");
            } else if (event.type === "error") {
              await controller.setContent(event.message);
            } else if (event.type === "tool_start" && !streamed) {
              await controller.setContent("正在处理你的请求…");
            }
          }
        },
      });
      const outcome = await completed;
      if ("error" in outcome) {
        throw outcome.error;
      }
      for (const view of outcome.reply.views) {
        await this.channel.send(
          chatId,
          { card: viewCard(view, input.conversationId) },
          { replyTo: sent.messageId },
        );
      }
    } finally {
      buffer.close();
      await completed;
    }
  }

  async notify(task: Task): Promise<void> {
    if (!["downloaded", "imported", "failed", "unknown"].includes(task.state)) {
      return;
    }
    const route = this.runtime.store.getFeishuRoute(task);
    if (!route || task.notifiedState === task.state) {
      return;
    }
    await this.deliveries.run(route.chatId, () =>
      this.channel.send(route.chatId, {
        text: `${task.title}\n${stateLabels[task.state]} · ${task.message}`,
      }),
    );
  }

  async close(): Promise<void> {
    this.stopReceiving();
    await this.deliveries.close();
    await this.idle();
    await this.channel.disconnect();
  }

  stopReceiving(): void {
    this.stopped = true;
    this.unsubscribe?.();
    void this.deliveries.close();
  }

  async idle(): Promise<void> {
    await Promise.all(this.pending);
  }
}
