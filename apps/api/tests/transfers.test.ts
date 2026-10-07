import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { TaskSummary, View, UserAction } from "@mp-pi/contracts";
import { fixture, input, media, transferRecord } from "./fixtures.js";
import { BackendRejectedError, UnknownSubmissionError } from "../src/core/errors.js";

function action(value: UserAction) {
  return { ...input(randomUUID(), "执行所选操作"), action: value };
}
async function query(f: Awaited<ReturnType<typeof fixture>>) {
  const reply = await f.handle(action({ type: "transfer_failures", page: 1 }));
  const view = reply.views.find((item) => item.kind === "transfer_failures");
  assert.ok(view?.kind === "transfer_failures");
  return view;
}
async function prepare(f: Awaited<ReturnType<typeof fixture>>, ids = ["101", "102"]) {
  const page = await query(f);
  const reply = await f.handle(
    action({ type: "prepare_transfer_retry", searchId: page.searchId, historyIds: ids }),
  );
  const view = reply.views.find((item) => item.kind === "confirmation");
  assert.ok(view?.kind === "confirmation");
  return view.task;
}
function confirm(task: TaskSummary) {
  return action({ type: "confirm", taskId: task.id, token: task.confirmationToken! });
}
function toolView(context: TranscriptContext, name: string): View {
  const result = [...context.messages]
    .reverse()
    .find((item) => item.role === "toolResult" && item.toolName === name);
  assert.ok(result?.role === "toolResult");
  const content = result.content.find((item) => item.type === "text");
  assert.ok(content?.type === "text");
  return JSON.parse(content.text);
}

test("Pi reads the MP skill, identifies a failed record and waits for subsequent batch confirmation", async (t) => {
  const f = await fixture(t);
  let searchId = "";
  let task!: TaskSummary;
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_skill", { name: "moviepilot-maintenance" })),
    fauxAssistantMessage(fauxToolCall("get_transfer_failures", {})),
    (context) => {
      const view = toolView(context, "get_transfer_failures");
      assert.ok(view.kind === "transfer_failures");
      searchId = view.searchId;
      return fauxAssistantMessage(fauxToolCall("search_media", { query: "Hamnet" }));
    },
    () =>
      fauxAssistantMessage(
        fauxToolCall("identify_transfer_records", {
          searchId,
          historyIds: ["101"],
          mediaKey: media.key,
        }),
      ),
    () =>
      fauxAssistantMessage(
        fauxToolCall("prepare_transfer_retry", { searchId, historyIds: ["101"] }),
      ),
    (context) => {
      const view = toolView(context, "prepare_transfer_retry");
      assert.ok(view.kind === "confirmation");
      task = view.task;
      return fauxAssistantMessage(
        fauxToolCall("confirm_task", { taskId: task.id, token: task.confirmationToken! }),
      );
    },
    (context) => {
      const result = context.messages.at(-1);
      assert.ok(result?.role === "toolResult" && result.isError);
      return fauxAssistantMessage("请核对整理预览后确认");
    },
  ]);
  await f.handle(input("mp-preview", "查询整理失败的记录，101 是哈姆奈特，重新整理"));
  assert.equal(f.backend.transferCalls.length, 0);
  assert.equal(task.transferItems?.[0]?.files[0]?.targetFilename, "哈姆奈特.101.mkv");
  await f.handle(confirm(task));
  assert.equal(f.backend.transferCalls.length, 1);
  assert.equal(f.backend.transferCalls[0]?.identification?.media.key, media.key);
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "completed");
});

test("selection is limited to the current owned failure page and old pages cannot submit", async (t) => {
  const f = await fixture(t);
  const page = await query(f);
  await assert.rejects(
    f.handle(
      action({ type: "prepare_transfer_retry", searchId: page.searchId, historyIds: ["999"] }),
    ),
    /当前列表/,
  );
  await query(f);
  await assert.rejects(
    f.handle(
      action({ type: "prepare_transfer_retry", searchId: page.searchId, historyIds: ["101"] }),
    ),
    /已更新/,
  );
  assert.equal(f.backend.transferCalls.length, 0);
});

test("overlapping source files cannot enter one retry batch", async (t) => {
  const f = await fixture(t);
  f.backend.transferRecords[1]!.sourceKey = f.backend.transferRecords[0]!.sourceKey;
  await assert.rejects(prepare(f), /重复或重叠/);
  assert.equal(f.backend.transferCalls.length, 0);
});

test("batch results persist per record and uncertain items are not submitted again", async (t) => {
  const f = await fixture(t);
  f.backend.transferRecords.push(transferRecord("103"));
  f.backend.transferErrors.set("102", new BackendRejectedError("rejected"));
  f.backend.transferErrors.set("103", new UnknownSubmissionError());
  const proposal = await prepare(f, ["101", "102", "103"]);
  await f.handle(confirm(proposal));
  const task = f.runtime.store.getTask("owner", proposal.id);
  assert.equal(task.state, "unknown");
  assert.ok(task.payload.kind === "transfer_retry");
  assert.deepEqual(
    task.payload.items.map((item) => item.state),
    ["completed", "failed", "unknown"],
  );
  await f.reopen();
  await f.handle(confirm(proposal));
  assert.equal(f.backend.transferCalls.length, 3);
  await assert.rejects(prepare(f, ["103"]), /已有任务/);
});

test("restart keeps completed records and marks an in-flight retry uncertain", async (t) => {
  const f = await fixture(t);
  const proposal = await prepare(f);
  const task = f.runtime.store.getTask("owner", proposal.id);
  assert.ok(task.payload.kind === "transfer_retry");
  task.state = "submitting";
  task.payload.items[0]!.state = "completed";
  task.payload.items[1]!.state = "submitting";
  f.runtime.store.saveTask(task);
  await f.reopen();
  const restored = f.runtime.store.getTask("owner", task.id);
  assert.equal(restored.state, "unknown");
  assert.ok(restored.payload.kind === "transfer_retry");
  assert.deepEqual(
    restored.payload.items.map((item) => item.state),
    ["completed", "unknown"],
  );
  await f.handle(confirm(proposal));
  assert.equal(f.backend.transferCalls.length, 0);
});

test("identification assignments survive later searches and restart", async (t) => {
  const f = await fixture(t);
  const page = await query(f);
  const context = {
    ...input("identification", "指定识别结果"),
    inputText: "指定识别结果",
    approvedTaskIds: new Set<string>(),
    publish: (_view: View) => undefined,
  };
  f.runtime.store.setCatalog(context, [media]);
  f.runtime.transfers.identify(page.searchId, ["101"], media.key, undefined, undefined, context);
  const other = { ...media, key: "themoviedb:222", id: "222", title: "另一个电影" };
  f.runtime.store.setCatalog(context, [other]);
  f.runtime.transfers.identify(page.searchId, ["102"], other.key, undefined, undefined, context);
  await f.reopen();
  const items = await f.runtime.transfers.preview(page.searchId, ["101", "102"], context);
  assert.deepEqual(
    items.map((item) => item.identification?.media.key),
    [media.key, other.key],
  );
  assert.equal(f.backend.transferCalls.length, 0);
});
