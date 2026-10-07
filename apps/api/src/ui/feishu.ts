import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type {
  LarkChannel,
  NormalizedMessage,
  CardActionEvent,
  EventMap,
} from "@larksuiteoapi/node-sdk";
import { actionSchema, stateLabels, type AgentInput, type AgentReply } from "@mp-pi/contracts";
import { AgentRuntime } from "../core/runtime.js";
import { ConflictError } from "../core/errors.js";
import type { Task } from "../domain/types.js";
import { viewCard } from "./feishu-cards.js";

const cardValueSchema = z.strictObject({ conversationId: z.string().uuid(), action: actionSchema });
const cardTokenSchema = z.object({ token: z.string().min(1) });

export interface FeishuOptions {
  ownerId: string;
  allowedOpenIds: string[];
  allowedGroupIds: string[];
  onError(error: unknown): void;
}

export interface FeishuTransport extends Pick<LarkChannel, "connect" | "disconnect" | "send"> {
  on(handlers: Partial<EventMap>): () => void;
}

export class FeishuUi {
  private unsubscribe?: () => void;
  private stopped = false;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly channel: FeishuTransport,
    private readonly options: FeishuOptions,
  ) {}

  async start(): Promise<void> {
    this.unsubscribe = this.channel.on({
      message: (message) => this.dispatch(() => this.message(message)),
      cardAction: (event) => this.dispatch(() => this.cardAction(event)),
      error: this.options.onError,
    });
    await this.channel.connect();
  }

  private dispatch(operation: () => Promise<void>): void {
    if (this.stopped) {
      return;
    }
    const pending = operation()
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
    // Enqueue before outbound I/O so user messages retain their receipt order.
    let reply: AgentReply;
    try {
      reply = await this.runtime.handle(input);
    } catch (error) {
      await this.channel.send(chatId, {
        text: "请求未能完成，请查看网页会话或服务日志。涉及下载时，请先核对任务状态再继续。",
      });
      throw error;
    }
    await this.channel.send(chatId, { text: reply.text || "操作结果如下。" });
    for (const view of reply.views) {
      await this.channel.send(chatId, { card: viewCard(view, input.conversationId) });
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
    await this.channel.send(route.chatId, {
      text: `${task.title}\n${stateLabels[task.state]} · ${task.message}`,
    });
  }

  async close(): Promise<void> {
    this.stopReceiving();
    await this.channel.disconnect();
    await this.idle();
  }

  stopReceiving(): void {
    this.stopped = true;
    this.unsubscribe?.();
  }

  async idle(): Promise<void> {
    await Promise.all(this.pending);
  }
}
