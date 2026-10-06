import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { TaskSummary, UserAction, View } from "@mp-pi/contracts";
import { fixture, input, media } from "./fixtures.js";
import { UnknownSubmissionError, BackendRejectedError } from "../src/core/errors.js";
import { TaskTracker } from "../src/services/task-tracker.js";

function confirmation(views: View[]): TaskSummary {
  const view = views.find((item) => item.kind === "confirmation");
  assert.ok(view?.kind === "confirmation");
  return view.task;
}
function toolResult(context: TranscriptContext, name: string): View {
  const result = [...context.messages]
    .reverse()
    .find((item) => item.role === "toolResult" && item.toolName === name);
  assert.ok(result?.role === "toolResult");
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text?.type === "text");
  return JSON.parse(text.text) as View;
}
function action(type: UserAction, requestId = randomUUID(), conversationId = "movie") {
  return { ...input(requestId, "执行所选操作", conversationId), action: type };
}
function confirm(task: TaskSummary, requestId = randomUUID()) {
  return action(
    { type: "confirm", taskId: task.id, token: task.confirmationToken! },
    requestId,
    task.conversationId,
  );
}
async function search(f: Awaited<ReturnType<typeof fixture>>) {
  f.runtime.store.ensureConversation(input("setup", "Hamnet"), "Hamnet");
  f.runtime.store.setCatalog(input("setup", "Hamnet"), [media]);
  const reply = await f.handle(action({ type: "resources", mediaKey: media.key }));
  const view = reply.views.find((item) => item.kind === "resources");
  assert.ok(view?.kind === "resources");
  return view;
}
function tracker(f: Awaited<ReturnType<typeof fixture>>) {
  return new TaskTracker(f.runtime.store, f.backend, {
    intervalMs: 30000,
    moviePilotUtcOffsetMinutes: 480,
    onTransition: async () => undefined,
    onError: (error) => {
      f.errors.push(error);
    },
  });
}

test("a real Pi function call cannot confirm its own proposal; a later exact user confirmation can", async (t) => {
  const f = await fixture(t);
  let task!: TaskSummary;
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("prepare_links", { links: `magnet:?xt=urn:btih:${"a".repeat(40)}` }),
    ),
    (context) => {
      const result = toolResult(context, "prepare_links");
      assert.equal(result.kind, "confirmation");
      task = confirmation([result]);
      return fauxAssistantMessage(
        fauxToolCall("confirm_task", { taskId: task.id, token: task.confirmationToken! }),
      );
    },
    (context) => {
      const result = [...context.messages].reverse().find((item) => item.role === "toolResult");
      assert.ok(result?.role === "toolResult" && result.isError);
      return fauxAssistantMessage("请确认后再执行");
    },
  ]);
  await f.handle(input("preview", "把这个磁力链接推送到115"));
  assert.equal(f.backend.submitCalls, 0);
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("confirm_task", { taskId: task.id, token: task.confirmationToken! }),
    ),
    fauxAssistantMessage("已提交，等待下载完成"),
  ]);
  await f.handle(input("approval", "确认"));
  assert.equal(f.backend.submitCalls, 1);
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "submitted");
});

test("confirmation is exactly once across simultaneous clicks and service restarts", async (t) => {
  const f = await fixture(t);
  const task = confirmation(
    (
      await f.handle(
        action({ type: "prepare_links", links: `magnet:?xt=urn:btih:${"a".repeat(40)}` }),
      )
    ).views,
  );
  await Promise.all([f.handle(confirm(task)), f.handle(confirm(task))]);
  await f.reopen();
  await f.handle(confirm(task));
  assert.equal(f.backend.submitCalls, 1);
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "submitted");
});

test("changing resource criteria invalidates old confirmations and supports clearing a condition", async (t) => {
  const f = await fixture(t);
  const view = await search(f);
  const task = confirmation(
    (
      await f.handle(
        action({
          type: "prepare_download",
          searchId: view.searchId,
          resourceId: view.items[0]!.id,
          destination: "moviepilot",
        }),
      )
    ).views,
  );
  const filtered = await f.handle(
    action({ type: "filter", searchId: view.searchId, criteria: { resolution: "1080p" } }),
  );
  const newer = filtered.views.find((item) => item.kind === "resources");
  assert.ok(newer?.kind === "resources");
  assert.equal(newer.items.length, 1);
  await f.handle(confirm(task));
  assert.equal(f.backend.submitCalls, 0);
  const cleared = await f.handle(
    action({ type: "filter", searchId: newer.searchId, criteria: {} }),
  );
  assert.equal(cleared.views.find((item) => item.kind === "resources")?.kind, "resources");
  assert.equal(f.runtime.store.getSearch(input("x", ""))?.criteria.resolution, undefined);
  await assert.rejects(
    f.handle(
      action({
        type: "prepare_download",
        searchId: view.searchId,
        resourceId: view.items[0]!.id,
        destination: "moviepilot",
      }),
    ),
    /失效/,
  );
});

test("confirmation cannot cross users or conversations and expired previews cannot submit", async (t) => {
  const f = await fixture(t);
  const task = confirmation(
    (
      await f.handle(
        action({ type: "prepare_links", links: `magnet:?xt=urn:btih:${"b".repeat(40)}` }),
      )
    ).views,
  );
  await assert.rejects(f.handle({ ...confirm(task), conversationId: "other" }), /不属于/);
  await assert.rejects(f.handle({ ...confirm(task), userId: "intruder" }), /不存在/);
  const privateTask = f.runtime.store.getTask("owner", task.id);
  privateTask.expiresAt = new Date(0).toISOString();
  f.runtime.store.saveTask(privateTask);
  await assert.rejects(f.handle(confirm(task)), /过期/);
  assert.equal(f.backend.submitCalls, 0);
});

test("uncertain writes are recorded and never automatically replayed or re-proposed", async (t) => {
  const f = await fixture(t);
  f.backend.submitError = new UnknownSubmissionError();
  const task = confirmation(
    (
      await f.handle(
        action({ type: "prepare_links", links: `magnet:?xt=urn:btih:${"c".repeat(40)}` }),
      )
    ).views,
  );
  const request = confirm(task);
  await assert.rejects(f.handle(request), /不确定/);
  await f.reopen();
  await assert.rejects(f.handle(request), /中断/);
  await f.handle(confirm(task));
  assert.equal(f.backend.submitCalls, 1);
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "unknown");
  await assert.rejects(
    f.handle(action({ type: "prepare_links", links: `magnet:?xt=urn:btih:${"c".repeat(40)}` })),
    /已有任务/,
  );
});

test("known rejection is a failed task and a new proposal can be created", async (t) => {
  const f = await fixture(t);
  f.backend.submitError = new BackendRejectedError("后端拒绝");
  const links = `magnet:?xt=urn:btih:${"d".repeat(40)}`;
  const task = confirmation((await f.handle(action({ type: "prepare_links", links }))).views);
  await assert.rejects(f.handle(confirm(task)), /拒绝/);
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "failed");
  assert.equal(
    confirmation((await f.handle(action({ type: "prepare_links", links }))).views).state,
    "awaiting_confirmation",
  );
});

test("115 resource submission preserves media identity and tracks actual download then library import", async (t) => {
  const f = await fixture(t);
  const view = await search(f);
  const selected = view.items[0]!;
  const task = confirmation(
    (
      await f.handle(
        action({
          type: "prepare_download",
          searchId: view.searchId,
          resourceId: selected.id,
          destination: "115",
        }),
      )
    ).views,
  );
  await f.handle(confirm(task));
  const stored = f.runtime.store.getTask("owner", task.id);
  assert.equal(stored.payload.kind, "resource");
  const hash = f.backend.resources.find((item) => item.id === selected.id)!.infoHash!;
  const poller = tracker(f);
  await poller.refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "submitted");
  f.backend.offline = [{ info_hash: hash, name: selected.title, status: 0, percent: 55 }];
  await poller.refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).progress, 55);
  f.backend.offline[0]!.status = 2;
  f.backend.offline[0]!.percent = 100;
  await poller.refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "downloaded");
  f.backend.library = { exists: true, playUrl: "http://jellyfin/library/item" };
  await poller.refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "imported");
  assert.equal(f.errors.length, 0);
});

test("absence from active downloads never proves completion, matching transfer and library do", async (t) => {
  const f = await fixture(t);
  const view = await search(f);
  const selected = view.items[0]!;
  const task = confirmation(
    (
      await f.handle(
        action({
          type: "prepare_download",
          searchId: view.searchId,
          resourceId: selected.id,
          destination: "moviepilot",
        }),
      )
    ).views,
  );
  await f.handle(confirm(task));
  const poller = tracker(f);
  await poller.refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "submitted");
  const hash = f.runtime.store.getTask("owner", task.id).backendId!;
  f.backend.transfers = [
    {
      download_hash: hash,
      status: true,
      date: "2099-01-01 12:00:00",
      media_source: media.source,
      media_id: media.id,
    },
  ];
  f.backend.library = { exists: true };
  await poller.refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "imported");
});

test("pre-existing library content and unrelated transfers cannot establish this task's import", async (t) => {
  const f = await fixture(t);
  f.backend.library = { exists: true };
  const view = await search(f);
  const selected = view.items[0]!;
  const task = confirmation(
    (
      await f.handle(
        action({
          type: "prepare_download",
          searchId: view.searchId,
          resourceId: selected.id,
          destination: "moviepilot",
        }),
      )
    ).views,
  );
  await f.handle(confirm(task));
  const hash = f.runtime.store.getTask("owner", task.id).backendId!;
  f.backend.downloads = [{ hash, progress: 100, completed: true }];
  f.backend.transfers = [
    {
      download_hash: "unrelated",
      status: true,
      date: "2099-01-01 12:00:00",
      media_source: media.source,
      media_id: media.id,
    },
  ];
  await tracker(f).refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "downloaded");
});

test("all hashes of a 115 batch must complete and only the exact job can report submission failure", async (t) => {
  const f = await fixture(t);
  const links = [
    `magnet:?xt=urn:btih:${"e".repeat(40)}`,
    `magnet:?xt=urn:btih:${"f".repeat(40)}`,
  ].join("\n");
  const task = confirmation((await f.handle(action({ type: "prepare_links", links }))).views);
  await f.handle(confirm(task));
  f.backend.submission = { ...f.backend.submission, id: "unrelated", status: "failed", failed: 1 };
  const poller = tracker(f);
  await poller.refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "submitted");
  f.backend.offline = [{ info_hash: "e".repeat(40), name: "one", percent: 100, status: 2 }];
  await poller.refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "downloading");
  assert.equal(f.runtime.store.getTask("owner", task.id).progress, 50);
  f.backend.offline.push({ info_hash: "f".repeat(40), name: "two", percent: 100, status: 2 });
  await poller.refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "downloaded");
});

test("native subscription changes require confirmation and use the selected operation", async (t) => {
  const f = await fixture(t);
  const task = confirmation(
    (
      await f.handle(
        action({ type: "subscription_change", subscriptionId: "1", operation: "pause" }),
      )
    ).views,
  );
  assert.equal(f.backend.changeCalls, 0);
  await f.handle(confirm(task));
  assert.equal(f.backend.changeCalls, 1);
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "completed");
});

test("native subscription operations can be repeated after the earlier operation completed", async (t) => {
  const f = await fixture(t);
  for (const operation of ["pause", "resume", "pause"] as const) {
    const task = confirmation(
      (await f.handle(action({ type: "subscription_change", subscriptionId: "1", operation })))
        .views,
    );
    await f.handle(confirm(task));
  }
  assert.equal(f.backend.changeCalls, 3);
});

test("different public torrent URLs resolving to one BTIH create one offline link", async (t) => {
  const f = await fixture(t);
  const task = confirmation(
    (
      await f.handle(
        action({
          type: "prepare_links",
          links: "https://example.test/a.torrent\nhttps://example.test/b.torrent",
        }),
      )
    ).views,
  );
  assert.match(task.title, /1 个链接/);
  await f.handle(confirm(task));
  assert.equal(f.backend.submittedLinks.length, 1);
});

test("115 lookup failure does not stop native tracking and is visible without changing confirmed state", async (t) => {
  const f = await fixture(t);
  const view = await search(f);
  const nativeTask = confirmation(
    (
      await f.handle(
        action({
          type: "prepare_download",
          searchId: view.searchId,
          resourceId: view.items[0]!.id,
          destination: "moviepilot",
        }),
      )
    ).views,
  );
  await f.handle(confirm(nativeTask));
  const offlineTask = confirmation(
    (
      await f.handle(
        action({ type: "prepare_links", links: `magnet:?xt=urn:btih:${"a".repeat(40)}` }),
      )
    ).views,
  );
  await f.handle(confirm(offlineTask));
  const hash = f.runtime.store.getTask("owner", nativeTask.id).backendId!;
  f.backend.downloads = [{ hash, progress: 55, completed: false }];
  f.backend.get115Tasks = async () => {
    throw new BackendRejectedError("115 暂不可用");
  };
  await assert.rejects(tracker(f).refresh(), /115 状态无法核对/);
  assert.equal(f.runtime.store.getTask("owner", nativeTask.id).state, "downloading");
  assert.equal(f.runtime.store.getTask("owner", offlineTask.id).state, "submitted");
  assert.match(f.runtime.store.getTask("owner", offlineTask.id).message, /查询失败/);
});

test("notification failure preserves the real final state and retries its persisted notification", async (t) => {
  const f = await fixture(t);
  const view = await search(f);
  const task = confirmation(
    (
      await f.handle(
        action({
          type: "prepare_download",
          searchId: view.searchId,
          resourceId: view.items[0]!.id,
          destination: "moviepilot",
        }),
      )
    ).views,
  );
  await f.handle(confirm(task));
  const hash = f.runtime.store.getTask("owner", task.id).backendId!;
  f.backend.downloads = [{ hash, progress: 100, completed: true }];
  f.backend.library = { exists: true };
  let calls = 0;
  const poller = new TaskTracker(f.runtime.store, f.backend, {
    intervalMs: 30000,
    moviePilotUtcOffsetMinutes: 480,
    onTransition: async () => {
      calls++;
      if (calls === 1) {
        throw new Error("Feishu unavailable");
      }
    },
    onError: (error) => {
      f.errors.push(error);
    },
  });
  await poller.refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "imported");
  assert.equal(f.runtime.store.getTask("owner", task.id).notifiedState, undefined);
  await poller.refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).notifiedState, "imported");
  await poller.refresh();
  assert.equal(calls, 2);
});

test("an episode resource tracks its actual season and episodes rather than waiting for a full TV series", async (t) => {
  const f = await fixture(t);
  const tv = {
    ...media,
    key: "themoviedb:123",
    id: "123",
    title: "示例剧集",
    type: "电视剧" as const,
    raw: {
      ...media.raw,
      media_id: "123",
      tmdb_id: 123,
      title: "示例剧集",
      type: "电视剧" as const,
    },
  };
  const selected = f.backend.resources[0]!;
  selected.tags.season = 2;
  selected.tags.episodes = [5];
  f.backend.resources = [selected];
  let hasEpisode = false;
  f.backend.checkLibrary = async (_media, criteria) => ({
    exists:
      hasEpisode &&
      criteria.season === 2 &&
      criteria.episodes?.length === 1 &&
      criteria.episodes[0] === 5,
  });
  f.runtime.store.ensureConversation(input("setup", "TV"), "TV");
  f.runtime.store.setCatalog(input("setup", "TV"), [tv]);
  const reply = await f.handle(action({ type: "resources", mediaKey: tv.key }));
  const view = reply.views.find((item) => item.kind === "resources");
  assert.ok(view?.kind === "resources");
  const task = confirmation(
    (
      await f.handle(
        action({
          type: "prepare_download",
          searchId: view.searchId,
          resourceId: selected.id,
          destination: "moviepilot",
        }),
      )
    ).views,
  );
  await f.handle(confirm(task));
  f.backend.downloads = [{ hash: selected.infoHash!, progress: 100, completed: true }];
  hasEpisode = true;
  await tracker(f).refresh();
  assert.equal(f.runtime.store.getTask("owner", task.id).state, "imported");
});

test("duplicate prevention searches durable history beyond the 500 visible recent tasks", async (t) => {
  const f = await fixture(t);
  const links = `magnet:?xt=urn:btih:${"a".repeat(40)}`;
  const summary = confirmation((await f.handle(action({ type: "prepare_links", links }))).views);
  const original = f.runtime.store.getTask("owner", summary.id);
  f.runtime.store.saveTask({ ...original, state: "unknown" });
  for (let index = 0; index < 501; index++) {
    f.runtime.store.saveTask({
      ...original,
      id: randomUUID(),
      state: "completed",
      kind: "subscription_change",
      submissionKey: randomUUID(),
      createdAt: "2099-01-01T00:00:00.000Z",
      payload: {
        kind: "subscription_change",
        subscriptionId: String(index + 1),
        operation: "pause",
      },
    });
  }
  assert.equal(
    f.runtime.store.listTasks("owner").some((task) => task.id === original.id),
    false,
  );
  await assert.rejects(f.handle(action({ type: "prepare_links", links })), /已有任务/);
  assert.equal(f.backend.submitCalls, 0);
});
