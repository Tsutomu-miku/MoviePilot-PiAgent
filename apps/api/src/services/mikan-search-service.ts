import { randomUUID } from "node:crypto";
import type { MikanQuery, MikanResourceSummary, View } from "@mp-pi/contracts";
import { ConflictError } from "../core/errors.js";
import { StateStore } from "../core/store.js";
import { extractTags } from "../domain/resources.js";
import type { Identity, MikanResource, MikanSnapshot, ToolContext } from "../domain/types.js";
import type { MediaBackend } from "../integrations/moviepilot.js";
import type { MikanPage } from "../integrations/mikan.js";

export const MIKAN_PAGE_SIZE = 20;

export function publicMikanResource({
  downloadUrl: _url,
  ...resource
}: MikanResource): MikanResourceSummary {
  return resource;
}

function normalizeRelease(release: MikanPage["items"][number]): MikanResource {
  const tags = extractTags(release.title, {});
  const group = release.title.match(/^\[([^\]]+)\]|^【([^】]+)】/);
  const episode = release.title.match(
    /\[(\d{1,3})(?:-(\d{1,3}))?\]|\bEP?(\d{1,3})\b| - (\d{1,3})(?:\D|$)/i,
  );
  const begin = Number(episode?.[1] ?? episode?.[3] ?? episode?.[4]);
  const end = Number(episode?.[2] ?? begin);
  if (!tags.episodes && begin > 0 && end >= begin && end - begin < 1000) {
    tags.episodes = Array.from({ length: end - begin + 1 }, (_, index) => begin + index);
  }
  return {
    id: release.id,
    title: release.title,
    sourceUrl: release.sourceUrl,
    downloadUrl: release.downloadUrl,
    sizeGiB: Math.round((release.size / 2 ** 30) * 100) / 100,
    publishedAt: release.publishedAt,
    group: group?.[1] ?? group?.[2],
    tags,
  };
}

export class MikanSearchService {
  constructor(
    private readonly store: StateStore,
    private readonly backend: MediaBackend,
  ) {}

  getSnapshot(identity: Identity, searchId: string): MikanSnapshot {
    const snapshot = this.store.getMikanSearch(identity);
    if (!snapshot || snapshot.id !== searchId) {
      throw new ConflictError("这份蜜柑列表已经失效，请使用最新结果");
    }
    return snapshot;
  }

  private view(snapshot: MikanSnapshot, offset: number): View {
    return {
      kind: "mikan",
      searchId: snapshot.id,
      query: snapshot.query,
      searchUrl: snapshot.searchUrl,
      received: snapshot.received,
      total: snapshot.resources.length,
      offset,
      items: snapshot.resources.slice(offset, offset + MIKAN_PAGE_SIZE).map(publicMikanResource),
    };
  }

  listResources(identity: Identity, searchId: string, offset: number): View {
    return this.view(this.getSnapshot(identity, searchId), offset);
  }

  select(identity: Identity, searchId: string, ids: string[]): MikanResource[] {
    const snapshot = this.getSnapshot(identity, searchId);
    return [...new Set(ids)].map((id) => {
      const resource = snapshot.resources.find((item) => item.id === id);
      if (!resource) {
        throw new ConflictError("所选资源不在当前蜜柑结果中，请重新选择");
      }
      return resource;
    });
  }

  async search(query: MikanQuery, context: ToolContext, signal?: AbortSignal): Promise<View> {
    for (const task of this.store.listTasks(context.userId, context.conversationId)) {
      if (
        task.state === "awaiting_confirmation" &&
        task.payload.kind === "links" &&
        task.payload.mikan
      ) {
        this.store.saveTask({
          ...task,
          state: "cancelled",
          message: "蜜柑搜索已更新，请重新选择资源",
          updatedAt: new Date().toISOString(),
        });
      }
    }
    this.store.setMikanSearch(context, null);
    const page = await this.backend.searchMikan(
      { keyword: query.keyword, group: query.group },
      signal,
    );
    const resources = page.items
      .map(normalizeRelease)
      .filter(
        (item) =>
          (!query.group || item.title.toLowerCase().includes(query.group.toLowerCase())) &&
          (!query.resolution || item.tags.resolution === query.resolution) &&
          (!query.subtitle || item.tags.subtitles.includes(query.subtitle)),
      );
    const snapshot: MikanSnapshot = {
      id: randomUUID(),
      query,
      searchUrl: page.searchUrl,
      received: page.received,
      resources,
    };
    this.store.setMikanSearch(context, snapshot);
    const view = this.view(snapshot, 0);
    context.publish(view);
    return view;
  }
}
