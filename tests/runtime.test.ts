import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { AgentRuntime } from "../src/core/runtime.js";
import type { AgentInput, UiEvent } from "../src/core/contracts.js";

const projectDir = resolve(import.meta.dirname, "../..");
function userText(context: TranscriptContext): string[] {
  return context.messages.filter(message => message.role === "user")
    .map(message => typeof message.content === "string" ? message.content : message.content
      .filter(block => block.type === "text").map(block => block.text).join(""));
}
const input = (requestId: string, text: string, conversationId = "movie", userId = "owner"): AgentInput =>
  ({ requestId, text, conversationId, userId });

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-agent-test-"));
  const faux = fauxProvider({ provider: "offline-test", tokensPerSecond: 1_000_000 });
  const models = await ModelRuntime.create({ authPath: join(dataDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  models.registerNativeProvider(faux.provider);
  let downloadCalls = 0;
  const options = {
    projectDir, dataDir, model: faux.getModel(), modelRuntime: models,
    backend: { getDownloading: async () => { downloadCalls++; return [{ hash: "test-task", state: "DOWNLOADING" }]; } },
  };
  let runtime = await AgentRuntime.create(options);
  t.after(async () => { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    get runtime() { return runtime; }, faux, options,
    get downloadCalls() { return downloadCalls; },
    reopen: async () => { await runtime.close(); runtime = await AgentRuntime.create(options); },
  };
}

test("real Pi SDK discovers Skill and executes scoped custom business tools", async t => {
  const f = await fixture(t);
  assert.deepEqual(f.runtime.getSkillNames(), ["media-request"]);
  f.runtime.store.setPreference("owner", "resolution", "4K", "user:以后默认4K");
  const events: UiEvent[] = [];
  f.faux.setResponses([
    context => {
      const system = JSON.stringify(context.messages.filter(message => message.role === "system"));
      assert.match(system, /media-request/);
      assert.doesNotMatch(system, /Use structured business tools to obtain facts/);
      const declared = context.messages.filter(message => message.role === "system")
        .flatMap(message => message.toolsAdded?.map(tool => tool.name) ?? []);
      assert.deepEqual([...declared].sort(), ["get_downloading", "get_preferences", "read_skill"]);
      return fauxAssistantMessage(fauxToolCall("read_skill", { name: "media-request" }));
    },
    context => {
      assert.match(JSON.stringify(context.messages), /Use structured business tools to obtain facts/);
      return fauxAssistantMessage(fauxToolCall("get_preferences", {}));
    },
    () => fauxAssistantMessage(fauxToolCall("get_downloading", {})),
    context => {
      const results = context.messages.filter(message => message.role === "toolResult");
      assert.deepEqual(results.map(message => message.toolName), ["read_skill", "get_preferences", "get_downloading"]);
      assert.equal(results.every(message => !message.isError), true);
      assert.match(JSON.stringify(results), /test-task/);
      assert.match(JSON.stringify(results), /4K/);
      return fauxAssistantMessage("有一个正在下载的任务");
    },
  ]);
  const reply = await f.runtime.handle(input("r1", "查看下载状态"), { publish: (_input, event) => events.push(event) });
  assert.equal(reply.text, "有一个正在下载的任务");
  assert.equal(f.downloadCalls, 1);
  assert.equal(events.filter(event => event.type === "tool_start").length, 3);
});

test("continuous messages queue in one session and different UI adapters share its context", async t => {
  const f = await fixture(t);
  const observed: string[][] = [];
  f.faux.setResponses([
    async context => {
      observed.push(userText(context));
      await new Promise(resolve => setTimeout(resolve, 20));
      return fauxAssistantMessage("请补充条件");
    },
    context => { observed.push(userText(context)); return fauxAssistantMessage("已补充英文名"); },
    context => { observed.push(userText(context)); return fauxAssistantMessage("已记录本次4K5.1要求"); },
  ]);
  const firstUi = { publish: () => undefined };
  const secondUi = { publish: () => undefined };
  await Promise.all([
    f.runtime.handle(input("r1", "下载电影哈姆奈特"), firstUi),
    f.runtime.handle(input("r2", "英文名Hamnet"), firstUi),
    f.runtime.handle(input("r3", "本次要4K5.1"), secondUi),
  ]);
  assert.deepEqual(observed.map(messages => messages.length), [1, 2, 3]);
  assert.match(observed[2]?.join(" ") ?? "", /哈姆奈特.*Hamnet.*4K5.1/);
  assert.deepEqual(f.runtime.store.getPreferences("owner"), {});
});

test("closing and reopening restores Pi history and SQLite user preferences", async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("已收到Hamnet")]);
  await f.runtime.handle(input("r1", "Hamnet"));
  f.runtime.store.setPreference("owner", "destination", "115", "user:以后默认115");
  await f.reopen();
  f.faux.setResponses([context => {
    assert.deepEqual(userText(context), ["Hamnet", "要4K"]);
    return fauxAssistantMessage("继续同一个电影请求");
  }]);
  assert.deepEqual(f.runtime.store.getPreferences("owner"), { destination: "115" });
  assert.equal((await f.runtime.handle(input("r2", "要4K"))).text, "继续同一个电影请求");
});

test("duplicate delivery is executed once, persists across restart, and rejects changed content", async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("只执行一次")]);
  const request = input("same-event", "检查任务");
  const [first, duplicate] = await Promise.all([f.runtime.handle(request), f.runtime.handle(request)]);
  assert.deepEqual(first, duplicate);
  assert.equal(f.faux.state.callCount, 1);
  await f.reopen();
  assert.deepEqual(await f.runtime.handle(request), first);
  assert.equal(f.faux.state.callCount, 1);
  await assert.rejects(f.runtime.handle({ ...request, text: "换成另一部电影" }), /different content/);
});

test("users and conversations have isolated history even when visible IDs overlap", async t => {
  const f = await fixture(t);
  const observed: string[][] = [];
  f.faux.setResponses([1, 2, 3].map(() => context => {
    observed.push(userText(context)); return fauxAssistantMessage("收到");
  }));
  await f.runtime.handle(input("r1", "Hamnet", "movie", "owner"));
  await f.runtime.handle(input("r1", "另一部电影", "movie", "second-user"));
  await f.runtime.handle(input("r2", "别的任务", "other", "owner"));
  assert.deepEqual(observed, [["Hamnet"], ["另一部电影"], ["别的任务"]]);
});

test("second service cannot own the same state directory", async t => {
  const f = await fixture(t);
  await assert.rejects(AgentRuntime.create(f.options), /already owns/);
});

test("failed or interrupted model runs are not replayed as duplicate deliveries", async t => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline failure" })]);
  const request = input("r1", "读取状态");
  await assert.rejects(f.runtime.handle(request), /did not complete/);
  await f.reopen();
  await assert.rejects(f.runtime.handle(request), /interrupted/);
  assert.equal(f.faux.state.callCount, 1);
});

test("unknown Skill requests stay scoped and become tool errors", async t => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_skill", { name: "../../private" })),
    context => {
      const result = context.messages.find(message => message.role === "toolResult");
      assert.ok(result && result.role === "toolResult" && result.isError);
      return fauxAssistantMessage("不存在这个Skill");
    },
  ]);
  assert.equal((await f.runtime.handle(input("r1", "读取Skill"))).text, "不存在这个Skill");
});

test("shutdown aborts the active run, rejects queued work, and cannot resurrect the service", { timeout: 5000 }, async t => {
  const f = await fixture(t);
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  f.faux.setResponses([async (_context, options) => {
    started();
    await new Promise<void>((_resolve, reject) => {
      const signal = options?.signal;
      if (!signal || signal.aborted) reject(new Error("aborted"));
      else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    return fauxAssistantMessage("should never complete");
  }]);
  const active = assert.rejects(f.runtime.handle(input("r1", "长请求")), /did not complete/);
  await ready;
  const queued = assert.rejects(f.runtime.handle(input("r2", "连续补充")), /stopping/);
  await Promise.all([f.runtime.close(), f.runtime.close(), active, queued]);
  await assert.rejects(f.runtime.handle(input("r3", "迟到的回调")), /stopping/);
  assert.equal(f.faux.state.callCount, 1);
});
