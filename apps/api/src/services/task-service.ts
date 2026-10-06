import { randomUUID } from "node:crypto";
import type { Destination, View } from "@mp-pi/contracts";
import { StateStore } from "../core/store.js";
import { ConflictError, BackendRejectedError } from "../core/errors.js";
import type { Identity, Task, TaskPayload, ToolContext } from "../domain/types.js";
import { publicTask } from "../domain/types.js";
import { filterResources } from "../domain/resources.js";
import { taskHashes, submissionKey } from "../domain/task-identity.js";
import { magnetHash, parseLinks } from "../domain/links.js";
import type { MediaBackend, ResolvedLink } from "../integrations/moviepilot.js";
import { SearchService } from "./search-service.js";

export class TaskService {
  constructor(
    private readonly store: StateStore,
    private readonly backend: MediaBackend,
    private readonly search: SearchService,
  ) {}

  private createTask(
    context: ToolContext,
    title: string,
    destination: Destination,
    payload: TaskPayload,
  ): Task {
    const key = submissionKey(destination, payload);
    const hashes = taskHashes(payload);
    const duplicate = this.store.findDuplicateTask(context.userId, destination, key, hashes);
    if (duplicate) {
      throw new ConflictError(`相同资源已有任务：${duplicate.title}，请在任务列表核对`);
    }
    for (const task of this.store.listTasks(context.userId, context.conversationId)) {
      if (task.state === "awaiting_confirmation") {
        this.store.saveTask({
          ...task,
          state: "cancelled",
          updatedAt: new Date().toISOString(),
          message: "已由新的待确认操作替换",
        });
      }
    }
    const now = new Date().toISOString();
    const kind =
      payload.kind === "resource" || payload.kind === "links" ? "download" : payload.kind;
    return {
      id: randomUUID(),
      userId: context.userId,
      conversationId: context.conversationId,
      kind,
      title,
      destination,
      state: "awaiting_confirmation",
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      preparedRequestId: context.requestId,
      submissionKey: key,
      confirmationToken: randomUUID(),
      payload,
      message: "请核对后确认；此操作在 15 分钟内有效。",
    };
  }

  private publishConfirmation(task: Task, context: ToolContext): View {
    this.store.saveTask(task);
    const view: View = { kind: "confirmation", task: publicTask(task) };
    context.publish(view);
    return view;
  }

  async prepareDownload(
    searchId: string,
    resourceId: string,
    destination: Destination,
    context: ToolContext,
    signal?: AbortSignal,
  ): Promise<View> {
    const snapshot = this.search.getSnapshot(context, searchId);
    const resource = filterResources(snapshot.resources, snapshot.criteria).find(
      (item) => item.id === resourceId,
    );
    if (!resource) {
      throw new ConflictError("资源不在当前筛选结果中，请重新选择");
    }
    if (destination === "115" && resource.torrent.site_cookie && !resource.infoHash) {
      throw new ConflictError(
        "这个种子链接需要站点登录。推送 115 需要磁力链接或可公开下载的种子链接。",
      );
    }
    const targetCriteria = { ...snapshot.criteria };
    if (snapshot.media.type === "电视剧") {
      targetCriteria.season ??= resource.tags.season;
      targetCriteria.episodes ??= resource.tags.episodes;
      if (!targetCriteria.season) {
        throw new ConflictError("请先明确下载季号");
      }
    }
    const library = await this.backend.checkLibrary(snapshot.media, targetCriteria, signal);
    const enclosure = resource.torrent.enclosure;
    if (!enclosure) {
      throw new ConflictError("资源缺少下载链接，请重新选择");
    }
    const resolved = destination === "115" ? await this.resolveLinks([enclosure], signal) : [];
    const task = this.createTask(context, resource.title, destination, {
      kind: "resource",
      media: snapshot.media,
      resource,
      criteria: targetCriteria,
      libraryBefore: library.exists,
      resolvedLinks: resolved.map((item) => item.magnet),
      infoHashes:
        resolved.length > 0
          ? resolved.map((item) => item.infoHash)
          : resource.infoHash
            ? [resource.infoHash]
            : [],
    });
    task.searchId = searchId;
    task.resourceId = resourceId;
    task.message = library.exists
      ? "媒体库已包含目标内容。确认后仍会提交这份资源。"
      : `将下载到${destination === "115" ? " 115 插件保存目录" : " MoviePilot 下载器"}，请确认。`;
    return this.publishConfirmation(task, context);
  }

  private async resolveLinks(links: string[], signal?: AbortSignal): Promise<ResolvedLink[]> {
    const result: ResolvedLink[] = [];
    for (const link of links) {
      const infoHash = magnetHash(link);
      if (infoHash) {
        result.push({ magnet: link, infoHash });
      } else {
        result.push(...(await this.backend.resolveLinks([link], signal)));
      }
    }
    return [...new Map(result.map((item) => [item.infoHash, item])).values()];
  }

  async prepareLinks(text: string, context: ToolContext, signal?: AbortSignal): Promise<View> {
    const resolved = await this.resolveLinks(parseLinks(text), signal);
    const task = this.createTask(context, `${resolved.length} 个链接推送到 115`, "115", {
      kind: "links",
      links: resolved.map((item) => item.magnet),
      infoHashes: resolved.map((item) => item.infoHash),
    });
    return this.publishConfirmation(task, context);
  }

  prepareSubscription(mediaKey: string, season: number | undefined, context: ToolContext): View {
    const media = this.search.getMedia(context, mediaKey);
    if (media.type === "电视剧" && season === undefined) {
      throw new ConflictError("请先指定订阅季号");
    }
    const title = `订阅 ${media.title}${season ? ` 第 ${season} 季` : ""}`;
    const task = this.createTask(context, title, "moviepilot", {
      kind: "subscription",
      media,
      season,
    });
    task.message = "将创建 MoviePilot 原生订阅。米柑 RSS 订阅需要在米柑管理。";
    return this.publishConfirmation(task, context);
  }

  async prepareSubscriptionChange(
    subscriptionId: string,
    operation: "pause" | "resume" | "delete",
    context: ToolContext,
    signal?: AbortSignal,
  ): Promise<View> {
    const subscriptions = await this.backend.listSubscriptions(signal);
    const subscription = subscriptions.find((item) => String(item.id) === subscriptionId);
    if (!subscription) {
      throw new ConflictError("订阅不存在");
    }
    const labels = { pause: "暂停", resume: "恢复", delete: "删除" };
    const task = this.createTask(
      context,
      `${labels[operation]}订阅 ${subscription.name}`,
      "moviepilot",
      {
        kind: "subscription_change",
        subscriptionId,
        operation,
      },
    );
    return this.publishConfirmation(task, context);
  }

  cancel(identity: Identity, taskId: string): View {
    const task = this.store.getTask(identity.userId, taskId);
    if (task.conversationId !== identity.conversationId || task.state !== "awaiting_confirmation") {
      throw new ConflictError("只能取消本会话中尚未提交的操作");
    }
    this.store.saveTask({
      ...task,
      state: "cancelled",
      updatedAt: new Date().toISOString(),
      message: "已取消",
    });
    return this.list(identity);
  }

  list(identity: Identity): View {
    return {
      kind: "tasks",
      items: this.store.listTasks(identity.userId, identity.conversationId).map(publicTask),
    };
  }

  private async submit(task: Task, signal?: AbortSignal): Promise<string> {
    switch (task.payload.kind) {
      case "links":
        return this.backend.submit115(task.payload.links, signal);
      case "resource": {
        if (task.destination === "moviepilot") {
          return this.backend.submitDownload(task.payload.media, task.payload.resource, signal);
        }
        return this.backend.submit115(task.payload.resolvedLinks, signal);
      }
      case "subscription":
        return this.backend.subscribe(task.payload.media, task.payload.season, signal);
      case "subscription_change":
        await this.backend.changeSubscription(
          task.payload.subscriptionId,
          task.payload.operation,
          signal,
        );
        return task.payload.subscriptionId;
    }
  }

  async confirm(
    taskId: string,
    token: string,
    context: ToolContext,
    signal?: AbortSignal,
  ): Promise<View> {
    const task = this.store.getTask(context.userId, taskId);
    if (task.conversationId !== context.conversationId || task.confirmationToken !== token) {
      throw new ConflictError("确认请求不属于当前会话");
    }
    if (task.state !== "awaiting_confirmation") {
      const view = this.list(context);
      context.publish(view);
      return view;
    }
    if (!context.approvedTaskIds.has(task.id) || task.preparedRequestId === context.requestId) {
      throw new ConflictError("需要用户在预览之后明确确认，模型不能自行提交");
    }
    if (Date.parse(task.expiresAt) <= Date.now()) {
      this.store.saveTask({
        ...task,
        state: "cancelled",
        updatedAt: new Date().toISOString(),
        message: "确认已过期",
      });
      throw new ConflictError("确认已过期，请重新预览");
    }
    if (task.searchId) {
      this.search.getSnapshot(context, task.searchId);
    }
    this.store.claimTask(task);
    task.state = "submitting";
    try {
      task.backendId = await this.submit(task, signal);
      task.state = task.kind === "download" ? "submitted" : "completed";
      task.message = task.kind === "download" ? "后端已受理，正在跟踪实际进度。" : "操作完成";
    } catch (error) {
      task.state = error instanceof BackendRejectedError ? "failed" : "unknown";
      task.message =
        task.state === "failed"
          ? "后端未接受请求，请检查配置后重新预览。"
          : "提交结果不确定，请核对后端任务；不会自动重试。";
      throw error;
    } finally {
      task.updatedAt = new Date().toISOString();
      this.store.saveTask(task);
      context.approvedTaskIds.delete(task.id);
      context.publish(this.list(context));
    }
    return this.list(context);
  }
}
