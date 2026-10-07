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

test("search, refine, preview and confirm a download; inspect shared task state", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await page.getByLabel("消息").fill("搜索哈姆奈特");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await expect(page.getByRole("button", { name: "搜索资源", exact: true }).last()).toBeEnabled();
  await page.getByRole("button", { name: "搜索资源", exact: true }).last().click();
  const resources = page.getByLabel("资源搜索结果").last();
  await expect(resources.getByText("匹配 2 条")).toBeVisible();
  await resources.getByText("筛选与排序条件").click();
  await resources.getByLabel("分辨率", { exact: true }).selectOption("2160p");
  await resources.getByLabel("声道", { exact: true }).selectOption("5.1");
  await resources.getByLabel("音频", { exact: true }).selectOption("DDP");
  await resources.getByRole("button", { name: "更新筛选" }).click();
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
  const records = page.getByLabel("整理失败记录").last();
  await expect(records.getByText("整理失败 · 共 2 条")).toBeVisible();
  await records.getByLabel("选择整理记录 101").check();
  await records.getByLabel("选择整理记录 102").check();
  await records.getByRole("button", { name: "预览所选记录" }).click();
  await expect(page.locator(".chat-history")).toHaveAttribute("aria-busy", "false");
  await expect(page.getByLabel("整理批次明细")).toContainText("哈姆奈特.101.mkv");
  await expect(page.getByRole("button", { name: "确认执行", exact: true })).toBeEnabled();
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
