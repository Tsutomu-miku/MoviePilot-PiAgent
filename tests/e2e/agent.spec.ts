import { test, expect, type Page } from "@playwright/test";

async function createConversation(page: Page) {
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/api/conversations") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "＋ 新建会话" }).click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const conversation = await response.json();
  await expect(page.locator(".conversation-list button.selected")).toHaveAttribute(
    "title",
    conversation.id,
  );
  await expect(page.getByLabel("消息")).toBeVisible();
}

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("访问令牌").fill("offline-browser-token-with-at-least-32-characters");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await createConversation(page);
}

async function expandResults(page: Page, title: string) {
  const card = page
    .locator(".result-card")
    .filter({ has: page.locator("summary > strong", { hasText: title }) })
    .last();
  await expect(card).not.toHaveAttribute("open");
  await card.locator(":scope > summary").click();
  await expect(card).toHaveAttribute("open");
}

test("MP hosted page uses its login and relative assets without a second access token", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page
    .context()
    .addCookies([{ name: "mp-test-admin", value: "1", url: "http://127.0.0.1:8789" }]);
  await page.goto("http://127.0.0.1:8789/api/v1/plugin/PiAgentBridge/ui/");
  await expect(page.getByLabel("访问令牌")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "退出登录" })).toHaveCount(0);
  await createConversation(page);
  await page.getByLabel("消息").fill("补充条件");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText("同一会话中已收到补充条件。", { exact: true })).toHaveCount(1);
  await expect(page.getByText("同一会话中已收到补充条件。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("pi-agent-token"))).toBeNull();
  expect(errors).toEqual([]);
});

test("an existing MP conversation accepts button and Enter sends on an insecure HTTP origin", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const created = await page.request.post("/api/conversations", {
    headers: { Authorization: "Bearer offline-browser-token-with-at-least-32-characters" },
    data: { title: "已有会话" },
  });
  expect(created.ok()).toBe(true);
  const conversation = await created.json();
  const base = "http://mp.test:8789";
  await page.context().addCookies([{ name: "mp-test-admin", value: "1", url: base }]);
  // Forward the hostname to the local fixture while preserving its HTTP origin.
  await page.route(`${base}/**`, async (route) => {
    const url = new URL(route.request().url());
    url.hostname = "127.0.0.1";
    const response = await route.fetch({ url: url.href });
    await route.fulfill({ response });
  });
  await page.goto(`${base}/api/v1/plugin/PiAgentBridge/ui/`);
  await page.locator(`.conversation-list button[title="${conversation.id}"]`).click();
  expect(
    await page.evaluate(() => ({
      secure: window.isSecureContext,
      nativeUuid: typeof crypto.randomUUID,
      randomBytes: typeof crypto.getRandomValues,
    })),
  ).toEqual({ secure: false, nativeUuid: "undefined", randomBytes: "function" });
  for (const method of ["button", "enter"] as const) {
    const sent = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith(`/conversations/${conversation.id}/messages`) &&
        response.request().method() === "POST",
    );
    await page.getByLabel("消息", { exact: true }).fill(`网页发送验证 ${method}`);
    if (method === "button") {
      await page.getByRole("button", { name: "发送", exact: true }).click();
    } else {
      await page.getByLabel("消息", { exact: true }).press("Enter");
    }
    const response = await sent;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON().requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    await expect(page.getByText(`网页发送验证 ${method}`, { exact: true })).toBeVisible();
    await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
  }
  await expect(page.getByText("同一会话中已收到补充条件。", { exact: true })).toHaveCount(2);
  await expect(page.getByLabel("消息", { exact: true })).toHaveValue("");
  await page.reload();
  await expect(page.getByText("网页发送验证 button", { exact: true })).toBeVisible();
  await expect(page.getByText("网页发送验证 enter", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("search, refine, preview and confirm a download; inspect shared task state", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await page.getByLabel("消息").fill("搜索哈姆奈特");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expandResults(page, "媒体搜索结果");
  await expect(page.getByRole("button", { name: "搜索资源", exact: true }).last()).toBeEnabled();
  await page.getByRole("button", { name: "搜索资源", exact: true }).last().click();
  await expandResults(page, "资源搜索结果");
  const resources = page.getByLabel("资源搜索结果").last();
  await expect(resources.getByText("匹配 2 条")).toBeVisible();
  await resources.getByText("筛选与排序条件").click();
  await resources.getByLabel("分辨率", { exact: true }).selectOption("2160p");
  await resources.getByLabel("声道", { exact: true }).selectOption("5.1");
  await resources.getByLabel("音频", { exact: true }).selectOption("DDP");
  await resources.getByRole("button", { name: "更新筛选" }).click();
  await expandResults(page, "资源搜索结果");
  const filtered = page.getByLabel("资源搜索结果").last();
  await expect(filtered.getByText("匹配 1 条")).toBeVisible();
  await expect(
    page
      .getByLabel("资源搜索结果")
      .first()
      .getByRole("button", { name: "下载到 MP", exact: true })
      .first(),
  ).toBeDisabled();
  await expect(filtered.getByRole("button", { name: "下载到 MP", exact: true })).toBeEnabled();
  await filtered.getByRole("button", { name: "下载到 MP", exact: true }).click();
  await expect(page.getByRole("button", { name: "确认执行", exact: true }).last()).toBeEnabled();
  await page.getByRole("button", { name: "确认执行", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "确认执行", exact: true })).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "功能" })
    .getByRole("button", { name: /^任务/ })
    .click();
  await expect(page.getByText("已提交", { exact: true })).toBeVisible();
  await expect(page.getByText("后端已受理，正在跟踪实际进度。", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "功能" }).getByRole("button", { name: /^任务/ }),
  ).toHaveCSS("background-color", "rgb(232, 237, 255)");
  await page.screenshot({ path: "test-results/tasks-desktop.png", fullPage: true });
  expect(errors).toEqual([]);
});

test("paste links to 115 and save or clear future defaults", async ({ page }) => {
  await login(page);
  await page.locator(".composer").getByRole("button", { name: "粘贴链接到 115" }).click();
  await page.getByLabel("种子链接").fill(`magnet:?xt=urn:btih:${"a".repeat(40)}`);
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText("1 个链接推送到 115", { exact: true })).toHaveCount(1);
  await expect(page.getByText("1 个链接推送到 115", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认执行" })).toBeEnabled();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page
    .getByRole("navigation", { name: "功能" })
    .getByRole("button", { name: "偏好", exact: true })
    .click();
  await page.getByLabel("默认目的地").selectOption("115");
  await page.getByLabel("分辨率", { exact: true }).selectOption("2160p");
  await page.getByRole("button", { name: "保存偏好" }).click();
  await expect(page.getByRole("status")).toContainText("偏好已保存");
  await page.reload();
  await page
    .getByRole("navigation", { name: "功能" })
    .getByRole("button", { name: "偏好", exact: true })
    .click();
  await expect(page.getByLabel("默认目的地")).toHaveValue("115");
  await expect(page.getByLabel("分辨率", { exact: true })).toHaveValue("2160p");
  await page.getByRole("button", { name: "清除全部偏好" }).click();
  await expect(page.getByLabel("分辨率", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("默认目的地")).toHaveValue("");
});

test("a preview cancelled in the same reply leaves one cancelled result without a confirmation button", async ({
  page,
}) => {
  await login(page);
  await page.getByLabel("消息").fill("预览后取消");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText("预览已取消，没有提交下载。", { exact: true })).toBeVisible();
  await expect(page.locator(".chat-history .task")).toHaveCount(1);
  await expect(page.locator(".chat-history .status")).toHaveText("已取消");
  await expect(page.getByRole("button", { name: "确认执行", exact: true })).toHaveCount(0);
  await expect(page.getByText("先生成一份预览。", { exact: true })).toBeVisible();
});

test("cards appear once after the final reply and queued turns keep their position during slow history refresh", async ({
  page,
}) => {
  await login(page);
  let releaseTasks!: () => void;
  let refreshStarted!: () => void;
  const heldTasks = new Promise<void>((resolve) => {
    releaseTasks = resolve;
  });
  const tasksRefresh = new Promise<void>((resolve) => {
    refreshStarted = resolve;
  });
  await page.evaluate(() => {
    const state = window as typeof window & { cardCounts: number[] };
    state.cardCounts = [];
    const observer = new MutationObserver(() => {
      state.cardCounts.push(document.querySelectorAll(".chat-history .task").length);
    });
    observer.observe(document.querySelector(".chat-history")!, { childList: true, subtree: true });
  });
  await page.getByLabel("消息").fill("卡片时机测试");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect
    .poll(async () => (await (await page.request.get("/test/reply-gate")).json()).previewReady)
    .toBe(true);
  await expect(page.locator(".chat-history .task")).toHaveCount(0);
  await expect(page.getByText("我先准备预览。", { exact: true })).toBeVisible();
  await expect(page.getByText("先解析链接，生成预览后再等待确认。", { exact: true })).toBeVisible();
  const tool = page
    .locator(".tool-block")
    .filter({ has: page.locator("code", { hasText: "prepare_links" }) });
  await expect(tool.locator(".tool-state")).toHaveText("已完成");
  await expect(tool).not.toHaveAttribute("open");
  await tool.locator(":scope > summary").click();
  await expect(tool.locator(".tool-detail")).toContainText("awaiting_confirmation");
  await page.locator(".thinking-block > summary").click();
  await expect(page.locator(".thinking-block")).not.toHaveAttribute("open");
  await expect(page.getByRole("button", { name: "确认执行", exact: true })).toHaveCount(0);
  await page.getByLabel("消息").fill("补充条件");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".chat-history .message")).toHaveClass([
    "message message-user",
    "message message-assistant",
    "message message-user",
    "message message-assistant",
  ]);
  await page.route("**/api/tasks", async (route) => {
    const response = await route.fetch();
    refreshStarted();
    await heldTasks;
    await route.fulfill({ response });
  });
  try {
    await page.request.post("/test/reply-gate/release");
    await tasksRefresh;
    await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
    await expect(page.getByText("最终预览已生成。", { exact: true })).toHaveCount(1);
    await expect(page.locator(".chat-history .task")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "确认执行", exact: true })).toBeEnabled();
    await expect(page.locator(".thinking-block")).not.toHaveAttribute("open");
    await expect(page.locator(".chat-history .message-user .message-text")).toHaveText([
      "卡片时机测试",
      "补充条件",
    ]);
    expect(
      await page.evaluate(() =>
        Math.max(...(window as typeof window & { cardCounts: number[] }).cardCounts),
      ),
    ).toBe(1);
  } finally {
    releaseTasks();
  }
  await expect(page.getByText("同一会话中已收到补充条件。", { exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByText("最终预览已生成。", { exact: true })).toHaveCount(1);
  await expect(page.locator(".chat-history .task")).toHaveCount(1);
  await expect(page.getByText("我先准备预览。", { exact: true })).toBeVisible();
  await expect(page.getByText("先解析链接，生成预览后再等待确认。", { exact: true })).toBeVisible();
  await expect(tool.locator(".tool-state")).toHaveText("已完成");
  await expect(tool).not.toHaveAttribute("open");
  await page.locator(".chat-history").evaluate((history) => {
    history.scrollTop = 0;
  });
  await page.screenshot({
    path: "test-results/conversation-transcript-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".chat-history").evaluate((history) => {
    history.scrollTop = 0;
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  await page.screenshot({
    path: "test-results/conversation-transcript-mobile.png",
    fullPage: true,
  });
});

test("mobile layout preserves conversation and exposes usable controls", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.getByLabel("消息")).toBeVisible();
  await page.request.post("/api/conversations", {
    headers: { Authorization: "Bearer offline-browser-token-with-at-least-32-characters" },
    data: { title: "A_very_long_conversation_title_that_should_never_expand_the_mobile_layout" },
  });
  await page.reload();
  await expect(page.getByLabel("消息")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.getByLabel("消息").fill("补充条件");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText("同一会话中已收到补充条件。", { exact: true })).toHaveCount(1);
  await expect(page.getByText("同一会话中已收到补充条件。", { exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/chat-mobile.png", fullPage: true });
});

test("select failed organization records, inspect the plan and confirm one batch", async ({
  page,
}) => {
  await login(page);
  await page.locator(".composer").getByRole("button", { name: "整理失败", exact: true }).click();
  await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
  await expandResults(page, "整理失败记录");
  const records = page.getByLabel("整理失败记录").last();
  await expect(records.getByText("整理失败 · 共 2 条")).toBeVisible();
  await records.getByLabel("选择整理记录 101").check();
  await records.getByLabel("选择整理记录 102").check();
  await records.getByRole("button", { name: "预览所选记录" }).click();
  await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByLabel("整理批次明细")).toContainText("哈姆奈特.101.mkv");
  await expect(page.getByLabel("整理批次明细")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "确认执行", exact: true })).toBeEnabled();
  await page.locator(".task-details > summary").last().click();
  await expect(page.getByLabel("整理批次明细")).toBeVisible();
  await page.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
  await page
    .getByRole("navigation", { name: "功能" })
    .getByRole("button", { name: /^任务/ })
    .click();
  await expect(
    page.getByText("整理完成 2 条，未受理 0 条，待核对 0 条，未执行 0 条。"),
  ).toBeVisible();
  await expect(page.getByLabel("整理批次明细")).toContainText("MP 报告整理完成");
});

test("personal Skill can be created, edited, disabled and selected in the existing web conversation", async ({
  page,
}) => {
  await login(page);
  const id = await page.locator(".conversation-list button.selected").getAttribute("title");
  const nav = page.getByRole("navigation", { name: "功能" });
  await nav.getByRole("button", { name: "技能", exact: true }).click();
  await page.getByRole("button", { name: "新建个人技能" }).click();
  const content = (body: string) =>
    `---\nname: browser-anime\ndescription: 浏览器测试的个人动画流程。\n---\n\n${body}`;
  await page.getByLabel("技能名称", { exact: true }).fill("browser-anime");
  await page.getByLabel("技能内容（SKILL.md）", { exact: true }).fill(content("私人初版说明"));
  await page.getByRole("button", { name: "保存技能", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("技能已保存");
  const skill = page
    .locator(".skill-list article")
    .filter({ has: page.getByText("browser-anime", { exact: true }) });
  await expect(skill.getByText("个人", { exact: true })).toBeVisible();
  await skill.getByRole("button", { name: "查看与编辑" }).click();
  await page.getByLabel("技能内容（SKILL.md）", { exact: true }).fill(content("私人新版说明"));
  await page.getByRole("button", { name: "保存技能", exact: true }).click();
  await expect(page.getByRole("button", { name: "保存技能", exact: true })).toBeEnabled();
  await skill.getByLabel("启用 browser-anime", { exact: true }).click();
  await expect(skill.getByLabel("启用 browser-anime", { exact: true })).not.toBeChecked();
  await expect(skill.getByRole("button", { name: "在对话中使用" })).toBeDisabled();
  await page.reload();
  await nav.getByRole("button", { name: "技能", exact: true }).click();
  await expect(skill.getByLabel("启用 browser-anime", { exact: true })).not.toBeChecked();
  await skill.getByRole("button", { name: "查看与编辑" }).click();
  await expect(page.getByLabel("技能内容（SKILL.md）", { exact: true })).toHaveValue(
    content("私人新版说明"),
  );
  await skill.getByLabel("启用 browser-anime", { exact: true }).click();
  await expect(skill.getByLabel("启用 browser-anime", { exact: true })).toBeChecked();
  await expect(skill.getByRole("button", { name: "在对话中使用" })).toBeEnabled();
  await skill.getByRole("button", { name: "在对话中使用" }).click();
  await expect(page.locator(".selected-skill")).toContainText("browser-anime");
  await expect(page.locator(".conversation-list button.selected")).toHaveAttribute("title", id!);
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith(`/conversations/${id}/messages`),
  );
  await page.getByLabel("消息", { exact: true }).fill("使用这个技能继续");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  expect((await sent).postDataJSON().skillName).toBe("browser-anime");
  await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByText("同一会话中已收到补充条件。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "取消选择" }).click();
  await expect(page.locator(".selected-skill")).toHaveCount(0);
});

test("Mikan direct search filters releases, invalidates old choices and previews a batch to 115", async ({
  page,
}) => {
  await login(page);
  await page.locator(".composer").getByRole("button", { name: "蜜柑搜索", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("动画关键词", { exact: true }).fill("花织");
  await dialog.getByRole("button", { name: "搜索蜜柑", exact: true }).click();
  await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
  const results = page.getByLabel("蜜柑搜索结果").last();
  await expandResults(page, "蜜柑搜索结果");
  await expect(results).toContainText("本次 RSS 返回 4 条，筛选后 4 条。");
  await results.getByLabel("字幕组", { exact: true }).fill("喵萌奶茶屋");
  await results.getByLabel("字幕", { exact: true }).selectOption("CHS");
  await results.getByLabel("分辨率", { exact: true }).selectOption("1080p");
  await results.getByRole("button", { name: "搜索蜜柑", exact: true }).click();
  await expandResults(page, "蜜柑搜索结果");
  const filtered = page.getByLabel("蜜柑搜索结果").last();
  await expect(filtered).toContainText("本次 RSS 返回 4 条，筛选后 2 条。");
  await expect(
    page.getByLabel("蜜柑搜索结果").first().getByRole("checkbox").first(),
  ).toBeDisabled();
  await expect(filtered.getByRole("checkbox").first()).toBeEnabled();
  await filtered.getByRole("checkbox").nth(0).check();
  await filtered.getByRole("checkbox").nth(1).check();
  await filtered.getByRole("button", { name: "预览到 115（2）", exact: true }).click();
  await expect(page.getByLabel("下载资源明细")).toContainText("花织同学 [01]");
  await expect(page.getByLabel("下载资源明细")).toContainText("花织同学 [02]");
  await expect(page.getByRole("button", { name: "确认执行", exact: true })).toBeEnabled();
  await expect(page.getByLabel("下载资源明细")).not.toBeVisible();
  await page.locator(".task-details > summary").last().click();
  await expect(page.getByLabel("下载资源明细")).toBeVisible();
  await page.screenshot({ path: "test-results/mikan-preview-desktop.png", fullPage: true });
  await page.getByRole("button", { name: "确认执行", exact: true }).click();
  await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
  await page
    .getByRole("navigation", { name: "功能" })
    .getByRole("button", { name: /^任务/ })
    .click();
  const task = page
    .locator(".task")
    .filter({ has: page.getByText("蜜柑 · 花织 · 2 个资源", { exact: true }) });
  await expect(task.getByText("已提交", { exact: true })).toBeVisible();
  await expect(task.getByLabel("下载资源明细")).toContainText("[01]");
});
