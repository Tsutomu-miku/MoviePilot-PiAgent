import { randomUUID } from "node:crypto";
import type { Criteria, View } from "@mp-pi/contracts";
import { StateStore } from "../core/store.js";
import { ConflictError, NotFoundError } from "../core/errors.js";
import type { Identity, Media, SearchSnapshot, ToolContext } from "../domain/types.js";
import { publicMedia, publicResource } from "../domain/types.js";
import { filterResources } from "../domain/resources.js";
import type { MediaBackend } from "../integrations/moviepilot.js";

export class SearchService {
  constructor(
    private readonly store: StateStore,
    private readonly backend: MediaBackend,
  ) {}

  invalidateSelection(identity: Identity, reason: string): void {
    for (const task of this.store.listTasks(identity.userId, identity.conversationId)) {
      if (task.state === "awaiting_confirmation" && task.payload.kind === "resource") {
        this.store.saveTask({
          ...task,
          state: "cancelled",
          message: reason,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  async searchMedia(query: string, context: ToolContext, signal?: AbortSignal): Promise<View> {
    this.invalidateSelection(context, "搜索目标已更新，请重新选择资源");
    this.store.setCatalog(context, []);
    const catalog = await this.backend.searchMedia(query, signal);
    this.store.setCatalog(context, catalog);
    const view: View = { kind: "media", items: catalog.map(publicMedia) };
    context.publish(view);
    return view;
  }

  getMedia(identity: Identity, key: string): Media {
    const media = this.store.getCatalog(identity).find((item) => item.key === key);
    if (!media) {
      throw new NotFoundError("媒体不在当前会话的搜索结果中，请重新搜索");
    }
    return media;
  }

  getSnapshot(identity: Identity, id: string): SearchSnapshot {
    const snapshot = this.store.getSearch(identity);
    if (!snapshot || snapshot.id !== id) {
      throw new ConflictError("这份资源列表已经失效，请使用最新结果");
    }
    return snapshot;
  }

  private resourceView(snapshot: SearchSnapshot, offset = 0): View {
    const matched = filterResources(snapshot.resources, snapshot.criteria);
    return {
      kind: "resources",
      searchId: snapshot.id,
      media: publicMedia(snapshot.media),
      criteria: snapshot.criteria,
      total: matched.length,
      items: matched.slice(offset, offset + 50).map(publicResource),
    };
  }

  listResources(identity: Identity, searchId: string, offset: number): View {
    return this.resourceView(this.getSnapshot(identity, searchId), offset);
  }

  async searchResources(
    mediaKey: string,
    criteria: Criteria,
    context: ToolContext,
    signal?: AbortSignal,
  ): Promise<View> {
    const media = this.getMedia(context, mediaKey);
    const { destination: _destination, ...defaults } = this.store.getPreferences(context.userId);
    const effectiveCriteria = { ...defaults, ...criteria };
    this.invalidateSelection(context, "资源搜索已更新，请重新选择");
    this.store.setSearch(context, null);
    const resources = await this.backend.searchResources(media, effectiveCriteria, signal);
    const snapshot: SearchSnapshot = {
      id: randomUUID(),
      media,
      criteria: effectiveCriteria,
      resources,
      createdAt: new Date().toISOString(),
    };
    this.store.setSearch(context, snapshot);
    const view = this.resourceView(snapshot);
    context.publish(view);
    return view;
  }

  async filter(
    searchId: string,
    criteria: Criteria,
    context: ToolContext,
    signal?: AbortSignal,
  ): Promise<View> {
    const current = this.getSnapshot(context, searchId);
    if (criteria.season !== current.criteria.season) {
      this.invalidateSelection(context, "季号已更新，请重新选择");
      this.store.setSearch(context, null);
      const resources = await this.backend.searchResources(current.media, criteria, signal);
      const snapshot: SearchSnapshot = { ...current, id: randomUUID(), criteria, resources };
      this.store.setSearch(context, snapshot);
      const view = this.resourceView(snapshot);
      context.publish(view);
      return view;
    }
    this.invalidateSelection(context, "筛选条件已更新，请重新确认选择");
    const snapshot: SearchSnapshot = {
      ...current,
      id: randomUUID(),
      criteria,
    };
    this.store.setSearch(context, snapshot);
    const view = this.resourceView(snapshot);
    context.publish(view);
    return view;
  }
}
