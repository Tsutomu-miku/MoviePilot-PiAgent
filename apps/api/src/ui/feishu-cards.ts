import type { View, UserAction } from "@mp-pi/contracts";
import { stateLabels } from "@mp-pi/contracts";

const titles: Record<View["kind"], string> = {
  transfer_failures: "整理失败记录",
  media: "媒体搜索结果",
  resources: "资源搜索结果",
  confirmation: "确认操作",
  tasks: "任务状态",
  subscriptions: "订阅",
  library: "媒体库",
};

function button(label: string, conversationId: string, action: UserAction): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    type: "default",
    value: { conversationId, action },
  };
}

function markdown(content: string): object {
  return { tag: "markdown", content };
}

function actions(items: object[]): object {
  return { tag: "action", actions: items };
}

export function viewCard(view: View, conversationId: string): object {
  const elements: object[] = [];
  switch (view.kind) {
    case "transfer_failures":
      elements.push(markdown(`整理失败共 ${view.total} 条 · 第 ${view.page} 页`));
      for (const item of view.items.slice(0, 10)) {
        elements.push(
          markdown(
            `#${item.id} · ${item.filename}\n${item.error}\n${item.identification ? `将识别为：${item.identification.media.title}` : "可用文字指定正确片名和季集"}`,
          ),
        );
        elements.push(
          actions([
            button("预览重新整理", conversationId, {
              type: "prepare_transfer_retry",
              searchId: view.searchId,
              historyIds: [item.id],
            }),
          ]),
        );
      }
      elements.push(markdown("批量选择可直接说明记录 ID，完整列表也可在网页勾选。"));
      if (view.page * view.count < view.total) {
        elements.push(
          actions([
            button("下一页", conversationId, {
              type: "transfer_failures",
              title: view.title,
              page: view.page + 1,
            }),
          ]),
        );
      }
      break;
    case "media":
      for (const media of view.items.slice(0, 10)) {
        elements.push(markdown(`${media.title} · ${media.year} · ${media.type}`));
        elements.push(
          actions([button("搜索资源", conversationId, { type: "resources", mediaKey: media.key })]),
        );
      }
      break;
    case "resources":
      elements.push(
        markdown(
          `${view.media.title} · 匹配 ${view.total} 条资源\n条件：${JSON.stringify(view.criteria)}`,
        ),
      );
      for (const resource of view.items.slice(0, 8)) {
        elements.push(
          markdown(
            `${resource.title}\n${resource.site} · ${resource.sizeGiB.toFixed(1)} GiB · 做种 ${resource.seeders}`,
          ),
        );
        elements.push(
          actions([
            button("下载到 MP", conversationId, {
              type: "prepare_download",
              searchId: view.searchId,
              resourceId: resource.id,
              destination: "moviepilot",
            }),
            button("推送到 115", conversationId, {
              type: "prepare_download",
              searchId: view.searchId,
              resourceId: resource.id,
              destination: "115",
            }),
          ]),
        );
      }
      if (view.total > 8) {
        elements.push(markdown("更多资源和完整筛选条件可在网页查看，或继续用文字调整条件。"));
      }
      break;
    case "confirmation": {
      const task = view.task;
      elements.push(
        markdown(
          `${task.title}\n保存到：${task.destination === "115" ? "115" : "MoviePilot"}\n${task.message}`,
        ),
      );
      for (const item of task.transferItems ?? []) {
        elements.push(
          markdown(
            `#${item.historyId} · ${item.filename}\n${item.title}\n${item.files
              .slice(0, 10)
              .map((file) => `${file.filename} → ${file.targetFilename}`)
              .join("\n")}\n${item.message}`,
          ),
        );
        if (item.files.length > 10) {
          elements.push(
            markdown(`另有 ${item.files.length - 10} 个目标文件，完整预览请在网页查看。`),
          );
        }
      }
      if (task.state === "awaiting_confirmation" && task.confirmationToken) {
        elements.push(
          actions([
            button("确认执行", conversationId, {
              type: "confirm",
              taskId: task.id,
              token: task.confirmationToken,
            }),
            button("取消", conversationId, { type: "cancel", taskId: task.id }),
          ]),
        );
      }
      break;
    }
    case "tasks":
      for (const task of view.items.slice(0, 15)) {
        elements.push(
          markdown(
            `${task.title}\n${stateLabels[task.state]}${task.progress === undefined ? "" : ` · ${task.progress.toFixed(0)}%`} · ${task.message}`,
          ),
        );
        if (task.transferItems) {
          elements.push(
            markdown(
              task.transferItems
                .map((item) => `#${item.historyId} · ${item.filename} · ${item.message}`)
                .join("\n"),
            ),
          );
        }
      }
      break;
    case "subscriptions":
      for (const item of view.items.slice(0, 15)) {
        elements.push(
          markdown(`${item.title}${item.season ? ` · 第 ${item.season} 季` : ""} · ${item.state}`),
        );
        elements.push(
          actions([
            button(item.state === "P" ? "恢复" : "暂停", conversationId, {
              type: "subscription_change",
              subscriptionId: item.id,
              operation: item.state === "P" ? "resume" : "pause",
            }),
            button("删除", conversationId, {
              type: "subscription_change",
              subscriptionId: item.id,
              operation: "delete",
            }),
          ]),
        );
      }
      break;
    case "library":
      elements.push(markdown(`${view.title} · ${view.exists ? "已入库" : "未入库"}`));
      break;
  }
  if (elements.length === 0) {
    elements.push(markdown("当前没有结果。"));
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: titles[view.kind] }, template: "blue" },
    elements,
  };
}
