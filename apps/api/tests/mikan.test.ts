import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { UserAction, View } from "@mp-pi/contracts";
import { fixture, input, mikanRelease } from "./fixtures.js";
import { viewCard } from "../src/ui/feishu-cards.js";
import { StateStore } from "../src/core/store.js";

function action(value: UserAction, conversationId = "anime", userId = "owner") {
  return { ...input(randomUUID(), "执行所选操作", conversationId, userId), action: value };
}
function result(context: TranscriptContext): View {
  const message = context.messages.at(-1);
  assert.ok(message?.role === "toolResult" && !message.isError);
  const block = message.content.find((item) => item.type === "text");
  assert.ok(block?.type === "text");
  return JSON.parse(block.text);
}

test("Pi directly searches Chinese Mikan releases and previews selected episodes before a later confirmation", async (t) => {
  const f = await fixture(t);
  f.backend.searchMedia = async () => {
    throw new Error("Mikan does not need media identification");
  };
  f.backend.searchResources = async () => {
    throw new Error("Mikan does not use PT matching");
  };
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_skill", { name: "mikan-search" })),
    fauxAssistantMessage(
      fauxToolCall("search_mikan", {
        keyword: "花织",
        group: "喵萌奶茶屋",
        resolution: "1080p",
        subtitle: "CHS",
      }),
    ),
    (context) => {
      const view = result(context);
      assert.ok(view.kind === "mikan");
      assert.equal(view.received, 4);
      assert.equal(view.total, 2);
      assert.deepEqual(
        view.items.map((item) => item.tags.episodes),
        [[1], [2]],
      );
      assert.doesNotMatch(JSON.stringify(view), /downloadUrl|magnet:/);
      return fauxAssistantMessage(
        fauxToolCall("prepare_mikan_download", {
          searchId: view.searchId,
          resourceIds: view.items.map((item) => item.id),
        }),
      );
    },
    (context) => {
      const view = result(context);
      assert.ok(view.kind === "confirmation");
      assert.equal(view.task.downloadItems?.length, 2);
      return fauxAssistantMessage("已找到简体 1080p 的第 1、2 集，请核对后确认。");
    },
  ]);
  const reply = await f.handle(input("search", "蜜柑搜索花织，喵萌奶茶屋简体，推送115", "anime"));
  assert.deepEqual(f.backend.mikanQueries, [{ keyword: "花织", group: "喵萌奶茶屋" }]);
  assert.equal(f.backend.resolvedUrls.length, 2);
  assert.equal(f.backend.submitCalls, 0);
  assert.deepEqual(
    reply.views.map((view) => view.kind),
    ["mikan", "confirmation"],
  );
  const preview = reply.views.at(-1);
  assert.ok(preview?.kind === "confirmation");
  const card = JSON.stringify(viewCard(preview, "anime"));
  assert.match(card, /花织同学/);
  assert.match(card, /确认执行/);
  await f.reopen();
  assert.equal(f.runtime.store.getMikanSearch(input("x", "", "anime"))?.resources.length, 2);
  await f.handle(
    action({ type: "confirm", taskId: preview.task.id, token: preview.task.confirmationToken! }),
  );
  assert.equal(f.backend.submitCalls, 1);
  assert.equal(f.backend.submittedLinks.length, 2);
  assert.notEqual(f.backend.submittedLinks[0], f.backend.submittedLinks[1]);
});

test("Mikan snapshots reject stale or foreign selection and a new query cancels its pending proposal", async (t) => {
  const f = await fixture(t);
  const search = await f.handle(
    action({ type: "mikan_search", query: { keyword: "花织", subtitle: "CHS" } }),
  );
  const view = search.views[0];
  assert.ok(view?.kind === "mikan");
  await assert.rejects(
    f.handle(
      action(
        {
          type: "prepare_mikan_download",
          searchId: view.searchId,
          resourceIds: [view.items[0]!.id],
        },
        "another",
      ),
    ),
    /失效/,
  );
  await assert.rejects(
    f.handle(
      action(
        {
          type: "prepare_mikan_download",
          searchId: view.searchId,
          resourceIds: [view.items[0]!.id],
        },
        "anime",
        "other-user",
      ),
    ),
    /失效/,
  );
  const filteredOut = f.backend.mikanReleases[2]!.id;
  await assert.rejects(
    f.handle(
      action({
        type: "prepare_mikan_download",
        searchId: view.searchId,
        resourceIds: [filteredOut],
      }),
    ),
    /不在当前/,
  );
  const preview = await f.handle(
    action({
      type: "prepare_mikan_download",
      searchId: view.searchId,
      resourceIds: [view.items[0]!.id],
    }),
  );
  const task = preview.views[0];
  assert.ok(task?.kind === "confirmation");
  await f.handle(action({ type: "mikan_search", query: { keyword: "花织", subtitle: "CHT" } }));
  assert.equal(f.runtime.store.getTask("owner", task.task.id).state, "cancelled");
  await f.handle(
    action({ type: "confirm", taskId: task.task.id, token: task.task.confirmationToken! }),
  );
  await assert.rejects(
    f.handle(
      action({
        type: "prepare_mikan_download",
        searchId: view.searchId,
        resourceIds: [view.items[0]!.id],
      }),
    ),
    /失效/,
  );
  assert.equal(f.backend.submitCalls, 0);
});

test("Mikan filters before pagination and keeps release IDs and Japanese title queries intact", async (t) => {
  const f = await fixture(t);
  f.backend.mikanReleases = Array.from({ length: 45 }, (_, index) =>
    mikanRelease(`【字幕组】作品 [${String(index + 1).padStart(2, "0")}][1080p][简体]`, index),
  );
  const reply = await f.handle(
    action({
      type: "mikan_search",
      query: { keyword: "日本語の原名", group: "字幕组", subtitle: "CHS" },
    }),
  );
  const view = reply.views[0];
  assert.ok(view?.kind === "mikan");
  assert.equal(view.total, 45);
  assert.equal(view.items.length, 20);
  const page = f.runtime.mikan.listResources(input("x", "", "anime"), view.searchId, 40);
  assert.ok(page.kind === "mikan");
  assert.equal(page.items.length, 5);
  assert.equal(page.items[0]?.group, "字幕组");
  assert.deepEqual(page.items[0]?.tags.episodes, [41]);
  assert.equal(page.items[0]?.id, f.backend.mikanReleases[40]?.id);
  assert.deepEqual(f.backend.mikanQueries[0], { keyword: "日本語の原名", group: "字幕组" });
});

test("adding the Mikan snapshot column preserves existing conversations, preferences and UI history", async (t) => {
  const f = await fixture(t);
  const oldMigrations = join(f.dataDir, "old-migrations");
  await mkdir(join(oldMigrations, "meta"), { recursive: true });
  const migrations = join(f.options.projectDir, "migrations");
  const journal = JSON.parse(await readFile(join(migrations, "meta", "_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, 2);
  for (const entry of journal.entries) {
    await cp(join(migrations, `${entry.tag}.sql`), join(oldMigrations, `${entry.tag}.sql`));
  }
  await writeFile(join(oldMigrations, "meta", "_journal.json"), JSON.stringify(journal));
  const dataDir = join(f.dataDir, "legacy-data");
  const identity = { userId: "owner", conversationId: "preserved" };
  const old = new StateStore(dataDir, oldMigrations);
  old.ensureConversation(identity, "原有会话");
  old.setPreferences("owner", { destination: "115" }, "明确默认要求");
  old.addMessage({ ...identity, requestId: "original" }, "user", "原有消息");
  old.close();
  const current = new StateStore(dataDir, migrations);
  try {
    assert.equal(current.getConversation(identity).title, "原有会话");
    assert.deepEqual(current.getPreferences("owner"), { destination: "115" });
    assert.equal(current.getMessages(identity)[0]?.text, "原有消息");
    assert.equal(current.getMikanSearch(identity), undefined);
  } finally {
    current.close();
  }
});
