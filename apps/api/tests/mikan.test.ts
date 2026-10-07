import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import Database from "better-sqlite3";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import type { UserAction, View } from "@mp-pi/contracts";
import { fixture, input, mikanRelease } from "./fixtures.js";
import { viewCard } from "../src/ui/feishu-cards.js";
import { StateStore } from "../src/core/store.js";
import { mikanAgentPage, type MikanAgentPage } from "../src/services/mikan-search-service.js";

function action(value: UserAction, conversationId = "anime", userId = "owner") {
  return { ...input(randomUUID(), "执行所选操作", conversationId, userId), action: value };
}
function result<T = View>(context: TranscriptContext): T {
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
      const view = result<MikanAgentPage>(context);
      assert.ok(view.kind === "mikan");
      assert.equal(view.received, 4);
      assert.equal(view.total, 2);
      assert.deepEqual(
        view.items.map((item) => item.tags.episodes),
        [[1], [2]],
      );
      assert.doesNotMatch(JSON.stringify(view), /downloadUrl|magnet:|"id":/);
      return fauxAssistantMessage(
        fauxToolCall("prepare_mikan_download", {
          searchId: view.searchId,
          resourceRefs: view.items.map((item) => item.ref),
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

test("Pi previews all twelve dual-subtitle episodes across pages using snapshot refs", async (t) => {
  const f = await fixture(t);
  f.backend.mikanReleases = Array.from({ length: 36 }, (_, index) => {
    const episode = 12 - Math.floor(index / 3);
    const version = ["简繁内封字幕", "简体", "繁体"][index % 3];
    return mikanRelease(
      `[字幕组] 作品 - ${String(episode).padStart(2, "0")} [1080p][${version}]`,
      index,
    );
  });
  const pages: MikanAgentPage[] = [];
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("search_mikan", { keyword: "作品" })),
    (context) => {
      const page = result<MikanAgentPage>(context);
      pages.push(page);
      assert.equal(page.items[0]?.ref, "m1");
      return fauxAssistantMessage(
        fauxToolCall("list_mikan_resources", { searchId: page.searchId, offset: 20 }),
      );
    },
    (context) => {
      const page = result<MikanAgentPage>(context);
      pages.push(page);
      assert.equal(page.items[0]?.ref, "m21");
      const selected = pages
        .flatMap((item) => item.items)
        .filter(
          (item) => item.tags.subtitles.includes("CHS") && item.tags.subtitles.includes("CHT"),
        );
      assert.equal(selected.length, 12);
      return fauxAssistantMessage(
        fauxToolCall("prepare_mikan_download", {
          searchId: page.searchId,
          resourceRefs: selected.map((item) => item.ref),
        }),
      );
    },
    (context) => {
      const view = result(context);
      assert.ok(view.kind === "confirmation");
      assert.equal(view.task.downloadItems?.length, 12);
      assert.deepEqual(
        view.task.downloadItems?.map((item) => item.tags.episodes?.[0]),
        [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
      );
      return fauxAssistantMessage("十二集预览已生成，请核对。");
    },
  ]);
  const reply = await f.handle(input("batch", "简繁内封，全12集", "anime"));
  assert.equal(f.backend.submitCalls, 0);
  assert.equal(f.backend.resolvedUrls.length, 12);
  const view = reply.views.find((item) => item.kind === "mikan");
  assert.ok(view?.kind === "mikan");
  assert.ok(view.items.every((item) => item.id.length === 64));
});

test("refs preserve their meaning after pagination and restart, and reject foreign, stale or missing targets", async (t) => {
  const f = await fixture(t);
  f.backend.mikanReleases = Array.from({ length: 36 }, (_, index) =>
    mikanRelease(`作品 [${index + 1}][1080p][CHS]`, index),
  );
  const reply = await f.handle(action({ type: "mikan_search", query: { keyword: "作品" } }));
  const view = reply.views[0];
  assert.ok(view?.kind === "mikan");
  const identity = input("x", "", "anime");
  const otherPage = mikanAgentPage(f.runtime.mikan.listResources(identity, view.searchId, 20));
  assert.equal(otherPage.items[0]?.ref, "m21");
  await f.reopen();
  assert.deepEqual(
    f.runtime.mikan.resourceIdsForRefs(identity, view.searchId, ["m1", "m21", "m36"]),
    [0, 20, 35].map((index) => f.backend.mikanReleases[index]!.id),
  );
  assert.throws(
    () => f.runtime.mikan.resourceIdsForRefs(identity, view.searchId, ["m37"]),
    /不在这份蜜柑结果/,
  );
  assert.throws(
    () =>
      f.runtime.mikan.resourceIdsForRefs({ ...identity, userId: "another-user" }, view.searchId, [
        "m1",
      ]),
    /失效/,
  );
  assert.throws(
    () =>
      f.runtime.mikan.resourceIdsForRefs(
        { ...identity, conversationId: "another-chat" },
        view.searchId,
        ["m1"],
      ),
    /失效/,
  );
  await f.handle(action({ type: "mikan_search", query: { keyword: "另一部" } }));
  assert.throws(() => f.runtime.mikan.resourceIdsForRefs(identity, view.searchId, ["m1"]), /失效/);
  assert.equal(f.backend.resolvedUrls.length, 0);
  assert.equal(f.backend.submitCalls, 0);
});

test("invalid refs and the old hash parameter cannot reach torrent resolution or create partial previews", async (t) => {
  const f = await fixture(t);
  const reply = await f.handle(action({ type: "mikan_search", query: { keyword: "作品" } }));
  const view = reply.views[0];
  assert.ok(view?.kind === "mikan");
  const invalid: Array<Record<string, string[]>> = [
    { resourceRefs: ["m0"] },
    { resourceRefs: ["m01"] },
    { resourceRefs: ["m37"] },
    { resourceRefs: ["a".repeat(40)] },
    { resourceIds: ["a".repeat(40)] },
  ];
  for (const selection of invalid) {
    f.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("prepare_mikan_download", { searchId: view.searchId, ...selection }),
      ),
      (context) => {
        const message = context.messages.at(-1);
        assert.ok(message?.role === "toolResult" && message.isError);
        return fauxAssistantMessage("资源引用无效。");
      },
    ]);
    await f.handle(input(randomUUID(), "预览选择", "anime"));
    assert.equal(f.backend.resolvedUrls.length, 0);
    assert.equal(f.runtime.store.listTasks("owner", "anime").length, 0);
  }
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("prepare_mikan_download", { searchId: view.searchId, resourceRefs: ["m1"] }),
    ),
    fauxAssistantMessage("有效资源已生成预览。"),
  ]);
  await f.handle(input(randomUUID(), "选择 m1", "anime"));
  assert.equal(f.backend.resolvedUrls.length, 1);
  assert.equal(f.runtime.store.listTasks("owner", "anime").length, 1);
  assert.equal(f.backend.submitCalls, 0);
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
  old.close();
  const legacy = new Database(join(dataDir, "agent.sqlite"));
  legacy
    .prepare(
      "INSERT INTO messages (id, user_id, conversation_id, role, text, views, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "original:user",
      identity.userId,
      identity.conversationId,
      "user",
      "原有消息",
      "[]",
      new Date().toISOString(),
    );
  legacy.close();
  const current = new StateStore(dataDir, migrations);
  try {
    assert.equal(current.getConversation(identity).title, "原有会话");
    assert.deepEqual(current.getPreferences("owner"), { destination: "115" });
    assert.equal(current.getMessages(identity)[0]?.text, "原有消息");
    assert.deepEqual(current.getMessages(identity)[0]?.transcript, []);
    assert.equal(current.getMikanSearch(identity), undefined);
  } finally {
    current.close();
  }
});
