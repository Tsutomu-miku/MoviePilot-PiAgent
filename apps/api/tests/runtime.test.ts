import { test } from "node:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { AgentRuntime } from "../src/core/runtime.js";
import type { UiEvent } from "@mp-pi/contracts";
import { fixture, input } from "./fixtures.js";

function userText(context: TranscriptContext): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join(""),
    );
}
test("real Pi SDK discovers Skill and executes scoped custom business tools", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.runtime.getSkillNames(), ["media-request", "preferences", "task-status"]);
  f.runtime.store.setPreferences("owner", { resolution: "2160p" }, "user:以后默认4K");
  const events: UiEvent[] = [];
  f.faux.setResponses([
    (context) => {
      const system = JSON.stringify(
        context.messages.filter((message) => message.role === "system"),
      );
      assert.match(system, /media-request/);
      assert.doesNotMatch(system, /Use structured business tools to obtain facts/);
      const declared = context.messages
        .filter((message) => message.role === "system")
        .flatMap((message) => message.toolsAdded?.map((tool) => tool.name) ?? []);
      assert.ok(declared.includes("prepare_download"));
      assert.ok(declared.includes("read_skill"));
      assert.ok(!declared.includes("bash"));
      return fauxAssistantMessage(fauxToolCall("read_skill", { name: "media-request" }));
    },
    (context) => {
      assert.match(
        JSON.stringify(context.messages),
        /Use structured business tools to obtain facts/,
      );
      return fauxAssistantMessage(fauxToolCall("get_preferences", {}));
    },
    () => fauxAssistantMessage(fauxToolCall("get_downloading", {})),
    (context) => {
      const results = context.messages.filter((message) => message.role === "toolResult");
      assert.deepEqual(
        results.map((message) => message.toolName),
        ["read_skill", "get_preferences", "get_downloading"],
      );
      assert.equal(
        results.every((message) => !message.isError),
        true,
      );
      assert.match(JSON.stringify(results), /test-task/);
      assert.match(JSON.stringify(results), /2160p/);
      return fauxAssistantMessage("有一个正在下载的任务");
    },
  ]);
  const reply = await f.handle(input("r1", "查看下载状态"), {
    publish: (_input, event) => events.push(event),
  });
  assert.equal(reply.text, "有一个正在下载的任务");
  assert.equal(f.backend.downloadCalls, 1);
  assert.equal(events.filter((event) => event.type === "tool_start").length, 3);
});

test("continuous messages queue in one session and different UI adapters share its context", async (t) => {
  const f = await fixture(t);
  const observed: string[][] = [];
  f.faux.setResponses([
    async (context) => {
      observed.push(userText(context));
      await new Promise((resolve) => setTimeout(resolve, 20));
      return fauxAssistantMessage("请补充条件");
    },
    (context) => {
      observed.push(userText(context));
      return fauxAssistantMessage("已补充英文名");
    },
    (context) => {
      observed.push(userText(context));
      return fauxAssistantMessage("已记录本次4K5.1要求");
    },
  ]);
  const firstUi = { publish: () => undefined };
  const secondUi = { publish: () => undefined };
  await Promise.all([
    f.handle(input("r1", "下载电影哈姆奈特"), firstUi),
    f.handle(input("r2", "英文名Hamnet"), firstUi),
    f.handle(input("r3", "本次要4K5.1"), secondUi),
  ]);
  assert.deepEqual(
    observed.map((messages) => messages.length),
    [1, 2, 3],
  );
  assert.match(observed[2]?.join(" ") ?? "", /哈姆奈特.*Hamnet.*4K5.1/);
  assert.deepEqual(f.runtime.store.getPreferences("owner"), {});
});

test("closing and reopening restores Pi history and SQLite user preferences", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("已收到Hamnet")]);
  await f.handle(input("r1", "Hamnet"));
  f.runtime.store.setPreferences("owner", { destination: "115" }, "user:以后默认115");
  await f.reopen();
  f.faux.setResponses([
    (context) => {
      assert.deepEqual(userText(context), ["Hamnet", "要4K"]);
      return fauxAssistantMessage("继续同一个电影请求");
    },
  ]);
  assert.deepEqual(f.runtime.store.getPreferences("owner"), { destination: "115" });
  assert.equal((await f.handle(input("r2", "要4K"))).text, "继续同一个电影请求");
});

test("duplicate delivery is executed once, persists across restart, and rejects changed content", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("只执行一次")]);
  const request = input("same-event", "检查任务");
  const [first, duplicate] = await Promise.all([f.handle(request), f.handle(request)]);
  assert.deepEqual(first, duplicate);
  assert.equal(f.faux.state.callCount, 1);
  await f.reopen();
  assert.deepEqual(await f.handle(request), first);
  assert.equal(f.faux.state.callCount, 1);
  await assert.rejects(f.handle({ ...request, text: "换成另一部电影" }), /不同内容/);
});

test("users and conversations have isolated history even when visible IDs overlap", async (t) => {
  const f = await fixture(t);
  const observed: string[][] = [];
  f.faux.setResponses(
    [1, 2, 3].map(() => (context) => {
      observed.push(userText(context));
      return fauxAssistantMessage("收到");
    }),
  );
  await f.handle(input("r1", "Hamnet", "movie", "owner"));
  await f.handle(input("r1", "另一部电影", "movie", "second-user"));
  await f.handle(input("r2", "别的任务", "other", "owner"));
  assert.deepEqual(observed, [["Hamnet"], ["另一部电影"], ["别的任务"]]);
});

test("second service cannot own the same state directory", async (t) => {
  const f = await fixture(t);
  await assert.rejects(AgentRuntime.create(f.options), /already being held/);
});

test("failed or interrupted model runs are not replayed as duplicate deliveries", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage("", { stopReason: "error", errorMessage: "offline failure" }),
  ]);
  const request = input("r1", "读取状态");
  await assert.rejects(f.handle(request), /未正常完成/);
  await f.reopen();
  await assert.rejects(f.handle(request), /中断/);
  assert.equal(f.faux.state.callCount, 1);
});

test("unknown Skill requests stay scoped and become tool errors", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("read_skill", { name: "../../private" })),
    (context) => {
      const result = context.messages.find((message) => message.role === "toolResult");
      assert.ok(result && result.role === "toolResult" && result.isError);
      return fauxAssistantMessage("不存在这个Skill");
    },
  ]);
  assert.equal((await f.handle(input("r1", "读取Skill"))).text, "不存在这个Skill");
});

test(
  "shutdown aborts the active run, rejects queued work, and cannot resurrect the service",
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t);
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.faux.setResponses([
      async (_context, options) => {
        started();
        await new Promise<void>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal || signal.aborted) {
            reject(new Error("aborted"));
          } else {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }
        });
        return fauxAssistantMessage("should never complete");
      },
    ]);
    const active = assert.rejects(f.handle(input("r1", "长请求")), /未正常完成/);
    await ready;
    const queued = assert.rejects(f.handle(input("r2", "连续补充")), /正在停止/);
    await Promise.all([f.runtime.close(), f.runtime.close(), active, queued]);
    await assert.rejects(f.runtime.handle(input("r3", "迟到的回调")), /正在停止/);
    assert.equal(f.faux.state.callCount, 1);
  },
);

test("request-only conditions cannot become future defaults, and explicit defaults can be saved and cleared", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("remember_preferences", {
        preferences: { resolution: "2160p" },
        reason: "本次请求",
      }),
    ),
    fauxAssistantMessage("只作为本次要求"),
  ]);
  await f.handle(input("once", "本次要4K"));
  assert.deepEqual(f.runtime.store.getPreferences("owner"), {});
  f.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("remember_preferences", {
        preferences: { resolution: "2160p", channels: "5.1" },
        reason: "用户明确指定默认",
      }),
    ),
    fauxAssistantMessage("已保存默认要求"),
  ]);
  await f.handle(input("save", "以后默认4K5.1"));
  assert.deepEqual(f.runtime.store.getPreferences("owner"), {
    resolution: "2160p",
    channels: "5.1",
  });
  f.faux.setResponses([
    fauxAssistantMessage(fauxToolCall("forget_preferences", {})),
    fauxAssistantMessage("已清除"),
  ]);
  await f.handle(input("clear", "清除全部偏好"));
  assert.deepEqual(f.runtime.store.getPreferences("owner"), {});
});

test("direct UI link actions record public facts in Pi history without exporting raw private query URLs", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("你好")]);
  await f.handle(input("hello", "你好"));
  await f.handle({
    ...input("links", "预览链接"),
    action: {
      type: "prepare_links",
      links: "https://example.test/file.torrent?passkey=private-query-token",
    },
  });
  f.faux.setResponses([
    (context) => {
      assert.doesNotMatch(JSON.stringify(context.messages), /private-query-token/);
      assert.match(JSON.stringify(context.messages), /prepare_links/);
      return fauxAssistantMessage("已有一个待确认的推送任务");
    },
  ]);
  await f.handle(input("continue", "继续"));
});
