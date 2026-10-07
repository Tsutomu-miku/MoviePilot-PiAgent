import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import type {
  EventMap,
  NormalizedMessage,
  SendInput,
  SendOptions,
  StreamInput,
} from "@larksuiteoapi/node-sdk";
import { FeishuUi, type FeishuTransport } from "../src/ui/feishu.js";
import { fixture, input } from "./fixtures.js";

class FakeChannel implements FeishuTransport {
  handlers: Partial<EventMap> = {};
  sent: Array<{ chatId: string; input: SendInput }> = [];
  streams: string[] = [];
  disconnected = false;
  failStream = false;

  on(handlers: Partial<EventMap>): () => void {
    this.handlers = handlers;
    return () => {
      this.handlers = {};
    };
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
  async send(chatId: string, message: SendInput, _options?: SendOptions) {
    this.sent.push({ chatId, input: message });
    return { messageId: randomUUID() };
  }
  async stream(_chatId: string, stream: StreamInput, _options?: SendOptions) {
    if (this.failStream) {
      throw new Error("outbound unavailable");
    }
    if (!("markdown" in stream)) {
      throw new Error("Expected markdown stream");
    }
    let text = "";
    await stream.markdown({
      messageId: randomUUID(),
      append: async (chunk) => {
        text += chunk;
      },
      setContent: async (content) => {
        text = content;
      },
    });
    this.streams.push(text);
    return { messageId: randomUUID() };
  }
}
function message(id: string, content: string, rootId = "root-one"): NormalizedMessage {
  return {
    messageId: id,
    chatId: "chat-one",
    chatType: "p2p",
    senderId: "ou_owner",
    content,
    rawContentType: "text",
    resources: [],
    mentions: [],
    mentionAll: false,
    mentionedBot: false,
    rootId,
    threadId: `thread-${id}`,
    createTime: Date.now(),
  };
}
function userText(context: TranscriptContext): string[] {
  return context.messages
    .filter((item) => item.role === "user")
    .map((item) =>
      typeof item.content === "string"
        ? item.content
        : item.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
    );
}

test("Feishu continuous messages use one persistent conversation despite changing reply roots", async (t) => {
  const f = await fixture(t);
  const channel = new FakeChannel();
  const ui = new FeishuUi(f.runtime, channel, {
    ownerId: "owner",
    allowedOpenIds: ["ou_owner"],
    allowedGroupIds: [],
    onError: (error) => {
      f.errors.push(error);
    },
  });
  await ui.start();
  const observed: string[][] = [];
  f.faux.setResponses(
    [1, 2, 3].map(() => (context) => {
      observed.push(userText(context));
      return fauxAssistantMessage("收到");
    }),
  );
  channel.handlers.message?.(message("one", "下载哈姆奈特"));
  channel.handlers.message?.(message("two", "Hamnet", "another-root"));
  channel.handlers.message?.(message("three", "要4K5.1", "third-root"));
  await ui.idle();
  assert.deepEqual(
    observed.map((items) => items.length),
    [1, 2, 3],
  );
  assert.match(observed[2]!.join(" "), /哈姆奈特.*Hamnet.*4K5.1/);
  assert.equal(f.runtime.store.listConversations("owner").length, 1);
  channel.handlers.message?.(message("two", "Hamnet"));
  await ui.idle();
  assert.equal(f.faux.state.callCount, 3);
  await ui.close();
  assert.equal(channel.disconnected, true);
  assert.equal(f.errors.length, 0);
});

test("Feishu can explicitly resume a web conversation and rejects cards belonging to another active conversation", async (t) => {
  const f = await fixture(t);
  const id = randomUUID();
  f.runtime.store.ensureConversation(input("setup", "web", id), "网页会话");
  const channel = new FakeChannel();
  const ui = new FeishuUi(f.runtime, channel, {
    ownerId: "owner",
    allowedOpenIds: ["ou_owner"],
    allowedGroupIds: [],
    onError: (error) => {
      f.errors.push(error);
    },
  });
  await ui.start();
  channel.handlers.message?.(message("switch", `/use ${id}`));
  await ui.idle();
  assert.equal(f.runtime.store.getBinding("owner", "feishu:chat-one:ou_owner"), id);
  channel.handlers.cardAction?.({
    messageId: "card",
    chatId: "chat-one",
    operator: { openId: "ou_owner" },
    action: {
      tag: "button",
      value: { conversationId: randomUUID(), action: { type: "cancel", taskId: randomUUID() } },
    },
    raw: { token: "event-token" },
  });
  await ui.idle();
  assert.match(JSON.stringify(channel.sent), /另一个会话/);
  assert.equal(f.backend.submitCalls, 0);
  await ui.close();
});

test("Feishu outbound failure leaves the core reply persisted and user identity remains enforced", async (t) => {
  const f = await fixture(t);
  const channel = new FakeChannel();
  channel.failStream = true;
  const ui = new FeishuUi(f.runtime, channel, {
    ownerId: "owner",
    allowedOpenIds: ["ou_owner"],
    allowedGroupIds: [],
    onError: (error) => {
      f.errors.push(error);
    },
  });
  await ui.start();
  f.faux.setResponses([fauxAssistantMessage("回复已保存")]);
  channel.handlers.message?.(message("one", "Hamnet"));
  await ui.idle();
  const id = f.runtime.store.getBinding("owner", "feishu:chat-one:ou_owner")!;
  assert.match(JSON.stringify(f.runtime.store.getMessages(input("x", "", id))), /回复已保存/);
  channel.handlers.message?.({ ...message("intruder", "下载"), senderId: "ou_intruder" });
  await ui.idle();
  assert.equal(f.faux.state.callCount, 1);
  assert.equal(f.errors.length, 2);
  await ui.close();
});

test("an empty group allowlist disables group execution even when the sender is an allowed owner", async (t) => {
  const f = await fixture(t);
  const channel = new FakeChannel();
  const ui = new FeishuUi(f.runtime, channel, {
    ownerId: "owner",
    allowedOpenIds: ["ou_owner"],
    allowedGroupIds: [],
    onError: (error) => {
      f.errors.push(error);
    },
  });
  await ui.start();
  channel.handlers.message?.({
    ...message("group", "下载电影"),
    chatType: "group",
    mentionedBot: true,
  });
  await ui.idle();
  assert.equal(f.faux.state.callCount, 0);
  assert.equal(f.runtime.store.listConversations("owner").length, 0);
  assert.equal(f.errors.length, 1);
  await ui.close();
});
