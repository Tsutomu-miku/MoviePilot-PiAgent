import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { decodeUiStream, type UiEvent } from "@mp-pi/contracts";
import { createApp } from "../src/http/app.js";
import { fixture } from "./fixtures.js";

const token = "offline-test-token-with-at-least-32-characters";
const headers = { authorization: `Bearer ${token}` };

test("HTTP derives identity from its authenticated owner and validates strict boundaries", async (t) => {
  const f = await fixture(t);
  const app = await createApp({
    runtime: f.runtime,
    ownerId: "owner",
    authToken: token,
    tracker: { refresh: async () => undefined },
  });
  t.after(() => app.close());
  assert.equal((await app.inject({ url: "/api/health" })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/tasks" })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/tasks?token=${token}` })).statusCode, 401);
  const created = await app.inject({
    method: "POST",
    url: "/api/conversations",
    headers,
    payload: { title: "Hamnet" },
  });
  const conversation = created.json<{ id: string }>();
  assert.equal(created.statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/conversations/${conversation.id}/messages`,
        headers,
        payload: { requestId: "x", text: "hello", userId: "intruder" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url: "/api/preferences",
        headers,
        payload: { resolution: "4K" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await app.inject({ url: `/api/conversations/${randomUUID()}/messages`, headers })).statusCode,
    404,
  );
  const saved = await app.inject({
    method: "PUT",
    url: "/api/preferences",
    headers,
    payload: { resolution: "2160p", destination: "115" },
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(f.runtime.store.getPreferences("owner"), {
    resolution: "2160p",
    destination: "115",
  });
});

test("HTTP streams Pi events, persists history and replays a duplicate reply without a second model call", async (t) => {
  const f = await fixture(t);
  const app = await createApp({
    runtime: f.runtime,
    ownerId: "owner",
    authToken: token,
    tracker: { refresh: async () => undefined },
  });
  t.after(() => app.close());
  const created = await app.inject({
    method: "POST",
    url: "/api/conversations",
    headers,
    payload: { title: "Hamnet" },
  });
  const { id } = created.json<{ id: string }>();
  f.faux.setResponses([fauxAssistantMessage("同一会话中的回复")]);
  const options = {
    method: "POST" as const,
    url: `/api/conversations/${id}/messages`,
    headers,
    payload: { requestId: "event-1", text: "Hamnet" },
  };
  const response = await app.inject(options);
  assert.match(response.headers["content-type"] ?? "", /text\/event-stream/);
  assert.match(response.body, /text_delta/);
  assert.match(response.body, /"type":"reply"/);
  const duplicate = await app.inject(options);
  assert.match(duplicate.body, /同一会话/);
  assert.equal(f.faux.state.callCount, 1);
  assert.equal(
    (await app.inject({ url: `/api/conversations/${id}/messages`, headers })).json<unknown[]>()
      .length,
    2,
  );
});

test("shared SSE decoder handles split UTF-8 and frame boundaries and detects incomplete streams", async () => {
  const reply: UiEvent = {
    type: "reply",
    reply: { conversationId: "conversation", requestId: "r", text: "哈姆奈特", views: [] },
  };
  const bytes = new TextEncoder().encode(`: heartbeat\n\ndata: ${JSON.stringify(reply)}\n\n`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 3) {
        controller.enqueue(bytes.slice(index, index + 3));
      }
      controller.close();
    },
  });
  const result: UiEvent[] = [];
  for await (const event of decodeUiStream(stream)) {
    result.push(event);
  }
  assert.deepEqual(result, [reply]);
  const incomplete = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  await assert.rejects(async () => {
    for await (const _event of decodeUiStream(incomplete)) {
      /* no events */
    }
  }, /断开/);
});

test("rate limiting preserves HTTP 429 and retry guidance rather than reporting a server failure", async (t) => {
  const f = await fixture(t);
  const app = await createApp({
    runtime: f.runtime,
    ownerId: "owner",
    authToken: token,
    tracker: { refresh: async () => undefined },
    rateLimitMax: 2,
  });
  t.after(() => app.close());
  for (let i = 0; i < 2; i++) {
    const reply = await app.inject({ url: "/api/preferences", headers });
    assert.equal(reply.statusCode, 200);
  }
  const limited = await app.inject({ url: "/api/preferences", headers });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, "RATE_LIMITED");
  assert.match(limited.headers["retry-after"]?.toString() ?? "", /^\d+$/);
});

test("automatically named conversations take their first message while explicit titles are preserved", async (t) => {
  const f = await fixture(t);
  const app = await createApp({
    runtime: f.runtime,
    ownerId: "owner",
    authToken: token,
    tracker: { refresh: async () => undefined },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: "/api/conversations",
    headers,
    payload: {},
  });
  const { id } = response.json<{ id: string }>();
  f.faux.setResponses([fauxAssistantMessage("收到"), fauxAssistantMessage("继续")]);
  await app.inject({
    method: "POST",
    url: `/api/conversations/${id}/messages`,
    headers,
    payload: { requestId: "one", text: "下载哈姆奈特" },
  });
  await app.inject({
    method: "POST",
    url: `/api/conversations/${id}/messages`,
    headers,
    payload: { requestId: "two", text: "要4K5.1" },
  });
  assert.equal(
    f.runtime.store.getConversation({ userId: "owner", conversationId: id }).title,
    "下载哈姆奈特",
  );
  const explicit = f.runtime.store.ensureConversation(
    { userId: "owner", conversationId: randomUUID() },
    "电影清单",
  );
  f.runtime.store.addMessage(
    { userId: "owner", conversationId: explicit.id },
    "user",
    "别改我的名称",
  );
  assert.equal(
    f.runtime.store.getConversation({ userId: "owner", conversationId: explicit.id }).title,
    "电影清单",
  );
});
