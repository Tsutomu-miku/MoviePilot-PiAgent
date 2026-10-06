import type { View, UserAction } from "@mp-pi/contracts";
import { stateLabels } from "@mp-pi/contracts";

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
      if (task.confirmationToken) {
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
    header: { title: { tag: "plain_text", content: "Pi Agent" }, template: "blue" },
    elements,
  };
}
