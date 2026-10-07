import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { View, UiEvent } from "@mp-pi/contracts";
import { fixture, input, media } from "./fixtures.js";

function latestResult(context: TranscriptContext): View {
  const result = context.messages.at(-1);
  assert.ok(result?.role === "toolResult" && !result.isError);
  const text = result.content.find((block) => block.type === "text");
  assert.ok(text?.type === "text");
  return JSON.parse(text.text);
}
function prepareLinks(hash: string) {
  return fauxAssistantMessage(
    fauxToolCall("prepare_links", { links: `magnet:?xt=urn:btih:${hash.repeat(40)}` }),
  );
}
function cancelPreview(context: TranscriptContext) {
  const view = latestResult(context);
  assert.ok(view.kind === "confirmation");
  return fauxAssistantMessage(fauxToolCall("cancel_task", { taskId: view.task.id }));
}

test("a preview cancelled within a turn has one final cancelled result and no confirmation card", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    prepareLinks("a"),
    cancelPreview,
    fauxAssistantMessage(fauxToolCall("get_tasks", {})),
    fauxAssistantMessage("已取消，未执行。"),
  ]);
  const request = input("cancel-preview", "预览后取消");
  const reply = await f.handle(request);
  assert.equal(reply.views.length, 1);
  const view = reply.views[0]!;
  assert.ok(view.kind === "tasks");
  assert.equal(view.items[0]!.state, "cancelled");
  assert.equal(view.items[0]!.confirmationToken, undefined);
  const wireReply = JSON.parse(JSON.stringify(reply));
  assert.deepEqual(f.runtime.store.getMessages(request).at(-1)!.views, wireReply.views);
  assert.deepEqual(await f.handle(request), wireReply);
  assert.equal(f.backend.submitCalls, 0);
});

test("a corrected proposal only exposes its current confirmation", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    prepareLinks("a"),
    prepareLinks("b"),
    fauxAssistantMessage("已修正预览，请确认。"),
  ]);
  const reply = await f.handle(input("correct-preview", "修正预览"));
  assert.equal(reply.views.length, 1);
  assert.ok(reply.views[0]!.kind === "confirmation");
  const tasks = f.runtime.store.listTasks("owner", "movie");
  assert.equal(tasks.filter((task) => task.state === "cancelled").length, 1);
  assert.equal(
    reply.views[0]!.task.id,
    tasks.find((task) => task.state === "awaiting_confirmation")!.id,
  );
  assert.equal(f.backend.submitCalls, 0);
});

test("task queries before and after a new preview cannot show an empty list or duplicate that confirmation", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("get_tasks", {})),
    prepareLinks("a"),
    fauxAssistantMessage(fauxToolCall("get_tasks", {})),
    fauxAssistantMessage("已生成预览，确认后执行。"),
  ]);
  const reply = await f.handle(input("query-preview", "先查询再预览"));
  assert.deepEqual(
    reply.views.map((view) => view.kind),
    ["confirmation"],
  );
});

test("a retry of media search shows the current results", async (t) => {
  const f = await fixture(t);
  f.backend.searchMedia = async (query) => (query === "Hamnet" ? [media] : []);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("search_media", { query: "wrong title" })),
    fauxAssistantMessage(fauxToolCall("search_media", { query: "Hamnet" })),
    fauxAssistantMessage("已找到哈姆奈特。"),
  ]);
  const reply = await f.handle(input("search-retry", "找哈姆奈特"));
  assert.equal(reply.views.length, 1);
  assert.ok(reply.views[0]!.kind === "media");
  assert.equal(reply.views[0]!.items[0]!.key, media.key);
});

test("a model failure after cancellation persists current task state rather than an obsolete confirmation", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    prepareLinks("a"),
    cancelPreview,
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline model failure" }),
  ]);
  const request = input("cancel-error", "取消后模型中断");
  await assert.rejects(f.handle(request), /未正常完成/);
  const views = f.runtime.store.getMessages(request).at(-1)!.views;
  assert.equal(views.length, 1);
  assert.ok(views[0]!.kind === "tasks");
  assert.equal(views[0]!.items[0]!.state, "cancelled");
  assert.equal(f.backend.submitCalls, 0);
});

test("streaming starts a fresh text segment after tools and the final reply contains only the final assistant text", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage([fauxText("我先查询当前下载。"), fauxToolCall("get_downloading", {})]),
    fauxAssistantMessage("有一个下载正在进行。"),
  ]);
  const events: UiEvent[] = [];
  const reply = await f.handle(input("stream-segments", "查下载"), {
    publish: (_input, event) => events.push(event),
  });
  const segments: string[] = [];
  for (const event of events) {
    if (event.type === "text_start") {
      segments.push("");
    }
    if (event.type === "text_delta") {
      segments[segments.length - 1] += event.text;
    }
  }
  assert.deepEqual(segments, ["我先查询当前下载。", "有一个下载正在进行。"]);
  assert.equal(reply.text, "有一个下载正在进行。");
});
