import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { applyTranscriptEvent, type TranscriptBlock, type UiEvent } from "@mp-pi/contracts";
import { fixture, input } from "./fixtures.js";

test("thinking, intermediate replies, tool results and final text stream in order and survive restart", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxThinking("先查看已存在的下载任务。"),
      fauxText("我先查询当前下载。"),
      fauxToolCall("get_downloading", {}),
    ]),
    fauxAssistantMessage([fauxThinking("已有一个下载。"), fauxText("有一个下载正在进行。")]),
  ]);
  let streamed: TranscriptBlock[] = [];
  const events: UiEvent[] = [];
  const request = input("transcript-order", "查下载");
  const reply = await f.handle(request, {
    publish: (_input, event) => {
      streamed = applyTranscriptEvent(streamed, event);
      events.push(event);
    },
  });
  assert.deepEqual(streamed, reply.transcript);
  assert.deepEqual(
    reply.transcript.map((block) => block.type),
    ["thinking", "text", "tool", "thinking", "text"],
  );
  const tool = reply.transcript[2]!;
  assert.ok(tool.type === "tool");
  assert.equal(tool.state, "completed");
  assert.equal(tool.input, "{}");
  assert.match(tool.output, /test-task/);
  assert.ok(events.some((event) => event.type === "tool_start"));
  assert.ok(events.some((event) => event.type === "block_delta" && event.text.includes("先查看")));
  assert.equal(reply.text, "有一个下载正在进行。");
  await f.reopen();
  assert.deepEqual(f.runtime.store.getMessages(request).at(-1)!.transcript, reply.transcript);
  assert.deepEqual((await f.handle(request)).transcript, reply.transcript);
  assert.equal(f.faux.state.callCount, 2);
});

test("parallel tool completions retain their invocation order and independent results", () => {
  let blocks: TranscriptBlock[] = [];
  const events: UiEvent[] = [
    { type: "tool_start", id: "first", name: "search_media", input: "{}" },
    { type: "tool_start", id: "second", name: "get_tasks", input: "{}" },
    { type: "tool_end", id: "second", name: "get_tasks", output: "no tasks", failed: false },
    { type: "tool_end", id: "first", name: "search_media", output: "search failed", failed: true },
  ];
  for (const event of events) {
    blocks = applyTranscriptEvent(blocks, event);
  }
  assert.deepEqual(
    blocks.map((block) => block.id),
    ["first", "second"],
  );
  assert.deepEqual(
    blocks.map((block) => block.type === "tool" && [block.state, block.output]),
    [
      ["failed", "search failed"],
      ["completed", "no tasks"],
    ],
  );
});

test("tool failures and a later model failure preserve the process without stale running indicators", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxText("先读取技能。"),
      fauxToolCall("read_skill", { name: "missing" }),
    ]),
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline failure" }),
  ]);
  const request = input("transcript-error", "查看技能");
  await assert.rejects(f.handle(request), /未正常完成/);
  const message = f.runtime.store.getMessages(request).at(-1)!;
  const tool = message.transcript.find((block) => block.type === "tool");
  assert.ok(tool?.type === "tool");
  assert.equal(tool.state, "failed");
  assert.match(tool.output, /技能|Skill/);
  assert.ok(
    message.transcript.some((block) => block.type === "text" && block.text === "先读取技能。"),
  );
  assert.equal(message.transcript.at(-1)!.type, "text");
  await f.reopen();
  assert.deepEqual(f.runtime.store.getMessages(request).at(-1)!.transcript, message.transcript);
});

test("resource tools expose public summaries in the transcript without backend credentials", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("search_media", { query: "Hamnet" })),
    (context) => {
      const result = context.messages.at(-1);
      assert.ok(result?.role === "toolResult");
      const text = result.content.find((block) => block.type === "text");
      assert.ok(text?.type === "text");
      const view = JSON.parse(text.text);
      return fauxAssistantMessage(
        fauxToolCall("search_resources", { mediaKey: view.items[0].key, criteria: {} }),
      );
    },
    fauxAssistantMessage("已找到资源。"),
  ]);
  const reply = await f.handle(input("transcript-public", "查资源"));
  assert.doesNotMatch(
    JSON.stringify(reply.transcript),
    /private-tracker-cookie|site_cookie|enclosure/,
  );
});

test("legacy UI turns recover their SDK process by timestamps without mixing identical prompts, actions or users", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage([
      fauxThinking("第一轮"),
      fauxText("先查询下载"),
      fauxToolCall("get_downloading", {}),
    ]),
    fauxAssistantMessage("第一次查到一个下载"),
    fauxAssistantMessage([
      fauxThinking("第二轮"),
      fauxText("再次查询下载"),
      fauxToolCall("get_downloading", {}),
    ]),
    fauxAssistantMessage([fauxText("第二次查询"), fauxText("仍然有一个下载")]),
    fauxAssistantMessage("另一个用户的私密回复"),
  ]);
  const first = input("legacy-one", "查下载");
  const second = input("legacy-two", "查下载");
  const firstReply = await f.handle(first);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.handle({
    ...input("legacy-action", "查询整理失败记录"),
    action: { type: "transfer_failures", page: 1 },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const secondReply = await f.handle(second);
  await f.handle(input("legacy-one", "查下载", "movie", "someone-else"));
  await f.runtime.close();
  const db = new Database(join(f.dataDir, "agent.sqlite"));
  db.prepare("UPDATE messages SET transcript = '[]' WHERE role = 'assistant'").run();
  db.close();
  await f.reopen();
  const history = f.runtime.getMessages(first);
  const recovered = (requestId: string) =>
    history.find((message) => message.id === `${requestId}:assistant`)!;
  assert.deepEqual(
    recovered("legacy-one").transcript.map((block) => block.type),
    firstReply.transcript.map((block) => block.type),
  );
  assert.match(JSON.stringify(recovered("legacy-one").transcript), /第一轮/);
  assert.doesNotMatch(JSON.stringify(recovered("legacy-one").transcript), /第二轮|私密回复/);
  assert.match(JSON.stringify(recovered("legacy-two").transcript), /第二轮/);
  assert.doesNotMatch(JSON.stringify(recovered("legacy-two").transcript), /第一轮|私密回复/);
  assert.deepEqual(recovered("legacy-action").transcript, []);
  assert.equal(recovered("legacy-two").text, secondReply.text);
  assert.equal(
    recovered("legacy-two").transcript.filter((block) => block.type === "text").length,
    3,
  );
  assert.equal(f.faux.state.callCount, 5);
});
