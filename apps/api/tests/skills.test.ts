import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { fixture, input } from "./fixtures.js";
import { createApp } from "../src/http/app.js";

const content = (body: string, name = "personal-anime") =>
  `---\nname: ${name}\ndescription: 私人动画检索流程。\n---\n\n${body}\n`;
function userMessages(context: TranscriptContext) {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) => JSON.stringify(message.content));
}

test("personal Skills override builtin content per owner, persist activation, and never change packaged instructions", async (t) => {
  const f = await fixture(t);
  const name = "mikan-search";
  const original = f.runtime.skills.get("owner", name);
  f.runtime.skills.save("owner", name, {
    content: content("私人偏好只属于我", name),
    enabled: true,
  });
  assert.equal(f.runtime.skills.get("owner", name).source, "personal");
  assert.match(f.runtime.skills.read("owner", name).content, /私人偏好/);
  assert.equal(f.runtime.skills.get("other-user", name).content, original.content);
  assert.equal(
    readFileSync(join(f.options.projectDir, "skills", name, "SKILL.md"), "utf8"),
    original.content,
  );
  f.runtime.skills.setEnabled("owner", name, false);
  assert.throws(() => f.runtime.skills.read("owner", name), /停用/);
  assert.ok(!f.runtime.getSkillNames("owner").includes(name));
  assert.ok(f.runtime.getSkillNames("other-user").includes(name));
  await f.reopen();
  assert.equal(f.runtime.skills.get("owner", name).enabled, false);
  f.runtime.skills.setEnabled("owner", name, true);
  assert.match(f.runtime.skills.read("owner", name).content, /私人偏好/);
  const root = join(
    f.dataDir,
    "personal-skills",
    createHash("sha256").update("owner").digest("hex"),
  );
  assert.equal(statSync(join(root, name, "SKILL.md")).mode & 0o777, 0o600);
});

test("editing and selecting a Skill reloads Pi resources next turn while retaining conversation history", async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([fauxAssistantMessage("记住这次会话内容")]);
  await f.handle(input("first", "先聊这部动画"));
  f.runtime.skills.save("owner", "personal-anime", {
    content: content("第一版说明"),
    enabled: true,
  });
  f.faux.setResponses([
    (context) => {
      assert.equal(userMessages(context).length, 2);
      assert.match(userMessages(context)[0]!, /先聊这部动画/);
      assert.match(userMessages(context)[1]!, /第一版说明/);
      assert.match(userMessages(context)[1]!, /继续搜索/);
      return fauxAssistantMessage("使用个人流程");
    },
  ]);
  await f.handle({ ...input("second", "继续搜索"), skillName: "personal-anime" });
  f.runtime.skills.save("owner", "personal-anime", {
    content: content("第二版说明"),
    enabled: true,
  });
  f.faux.setResponses([
    (context) => {
      assert.equal(userMessages(context).length, 3);
      assert.match(userMessages(context)[2]!, /第二版说明/);
      assert.match(JSON.stringify(context.messages), /记住这次会话内容/);
      return fauxAssistantMessage("保持原会话并使用新版");
    },
  ]);
  await f.handle({ ...input("third", "继续"), skillName: "personal-anime" });
  f.runtime.skills.setEnabled("owner", "personal-anime", false);
  const calls = f.faux.state.callCount;
  await assert.rejects(
    f.handle({ ...input("disabled", "再搜索"), skillName: "personal-anime" }),
    /停用/,
  );
  assert.equal(f.faux.state.callCount, calls);
});

test("Skill HTTP routes derive the owner and reject bad metadata without overwriting the saved version", async (t) => {
  const f = await fixture(t);
  const authToken = "offline-skill-test-token-long-enough";
  const app = await createApp({
    runtime: f.runtime,
    tracker: { refresh: async () => undefined },
    ownerId: "owner",
    authToken,
  });
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${authToken}` };
  assert.equal((await app.inject({ url: "/api/skills" })).statusCode, 401);
  const url = "/api/skills/personal-anime";
  const valid = { content: content("有效说明"), enabled: true };
  assert.equal((await app.inject({ method: "PUT", url, headers, payload: valid })).statusCode, 200);
  assert.equal(
    (await app.inject({ method: "PUT", url, headers, payload: { ...valid, userId: "intruder" } }))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url,
        headers,
        payload: { ...valid, content: content("不同名称", "other-name") },
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url,
        headers,
        payload: { ...valid, content: "---\nname: [broken\ndescription: test\n---\nbody" },
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await app.inject({
        method: "PUT",
        url,
        headers,
        payload: { ...valid, content: "---\nname: personal-anime\n---\nbody" },
      })
    ).statusCode,
    400,
  );
  assert.equal((await app.inject({ url, headers })).json().content, valid.content);
  assert.throws(() => f.runtime.skills.get("other-user", "personal-anime"), /未找到/);
  assert.throws(() => f.runtime.skills.save("owner", "../escape", valid));
  const disabled = await app.inject({
    method: "PUT",
    url: `${url}/activation`,
    headers,
    payload: { enabled: false },
  });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().enabled, false);
  assert.equal((await app.inject({ url: "/api/skills/unknown", headers })).statusCode, 404);
});

test("Skill discovery and writes reject symlinks leaving the owner's directory", async (t) => {
  const f = await fixture(t);
  const root = join(
    f.dataDir,
    "personal-skills",
    createHash("sha256").update("owner").digest("hex"),
  );
  const outside = join(f.dataDir, randomUUID());
  mkdirSync(outside);
  writeFileSync(join(outside, "SKILL.md"), content("其他用户的内容", "escaped"));
  mkdirSync(root, { recursive: true });
  symlinkSync(outside, join(root, "escaped"));
  assert.throws(() => f.runtime.skills.load("owner"), /自己的技能目录/);
  assert.throws(() => f.runtime.skills.read("owner", "escaped"), /自己的技能目录/);
  assert.throws(
    () =>
      f.runtime.skills.save("owner", "escaped", {
        content: content("不能写到外部", "escaped"),
        enabled: true,
      }),
    /自己的技能目录/,
  );
  assert.match(readFileSync(join(outside, "SKILL.md"), "utf8"), /其他用户的内容/);
});
