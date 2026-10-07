import { randomUUID } from "node:crypto";
import type { View } from "@mp-pi/contracts";
import type { StateStore } from "../core/store.js";
import { ConflictError } from "../core/errors.js";
import type { MediaBackend } from "../integrations/moviepilot.js";
import type {
  TransferAssignment,
  TransferIdentification,
  TransferQuery,
} from "../integrations/transfers.js";
import type {
  Identity,
  ToolContext,
  TransferRetryItem,
  TransferSnapshot,
} from "../domain/types.js";
import { publicMedia } from "../domain/types.js";
import type { SearchService } from "./search-service.js";

export class TransferService {
  constructor(
    private readonly store: StateStore,
    private readonly backend: MediaBackend,
    private readonly search: SearchService,
  ) {}

  private snapshot(identity: Identity, searchId: string): TransferSnapshot {
    const snapshot = this.store.getTransfers(identity);
    if (!snapshot || snapshot.id !== searchId) {
      throw new ConflictError("整理记录列表已更新，请使用当前列表重新选择");
    }
    return snapshot;
  }

  private invalidate(context: ToolContext): void {
    for (const task of this.store.listTasks(context.userId, context.conversationId)) {
      if (task.kind === "transfer_retry" && task.state === "awaiting_confirmation") {
        this.store.saveTask({
          ...task,
          state: "cancelled",
          updatedAt: new Date().toISOString(),
          message: "整理记录或识别条件已更新，请重新预览",
        });
      }
    }
  }

  private view(snapshot: TransferSnapshot): View {
    return {
      kind: "transfer_failures",
      title: snapshot.title,
      searchId: snapshot.id,
      page: snapshot.page,
      count: snapshot.count,
      total: snapshot.total,
      items: snapshot.items,
    };
  }

  async query(query: TransferQuery, context: ToolContext, signal?: AbortSignal): Promise<View> {
    const page = await this.backend.listTransferFailures(query, signal);
    const snapshot = { ...page, id: randomUUID() };
    this.invalidate(context);
    this.store.setTransfers(context, snapshot);
    const view = this.view(snapshot);
    context.publish(view);
    return view;
  }

  identify(searchId: string, assignments: TransferAssignment[], context: ToolContext): View {
    const snapshot = this.snapshot(context, searchId);
    this.select(
      snapshot,
      assignments.map((assignment) => assignment.historyId),
    );
    const identifications = new Map<string, TransferIdentification>();
    for (const { historyId, mediaKey, season, episodes } of assignments) {
      const media = this.search.getMedia(context, mediaKey);
      if (media.type === "电影" && (season !== undefined || episodes !== undefined)) {
        throw new ConflictError("电影整理不使用季集号");
      }
      identifications.set(historyId, { media: publicMedia(media), season, episodes });
    }
    const updated = {
      ...snapshot,
      items: snapshot.items.map((item) => {
        const identification = identifications.get(item.id);
        return identification ? { ...item, identification } : item;
      }),
    };
    this.invalidate(context);
    this.store.setTransfers(context, updated);
    const view = this.view(updated);
    context.publish(view);
    return view;
  }

  private select(snapshot: TransferSnapshot, historyIds: string[]): Set<string> {
    const selected = new Set(historyIds);
    if (
      selected.size !== historyIds.length ||
      selected.size === 0 ||
      selected.size > 20 ||
      historyIds.some((id) => !snapshot.items.some((item) => item.id === id))
    ) {
      throw new ConflictError("请选择当前列表中 1 至 20 条不同的整理记录");
    }
    return selected;
  }

  async preview(
    searchId: string,
    historyIds: string[],
    context: ToolContext,
    signal?: AbortSignal,
  ): Promise<TransferRetryItem[]> {
    const snapshot = this.snapshot(context, searchId);
    this.select(snapshot, historyIds);
    const files = new Set<string>();
    const targets = new Set<string>();
    const result: TransferRetryItem[] = [];
    for (const id of historyIds) {
      const selected = snapshot.items.find((item) => item.id === id)!;
      const record = await this.backend.getTransferRecord(id, signal);
      if (record.filename !== selected.filename) {
        throw new ConflictError("整理记录的源文件已变化，请重新查询");
      }
      const command = {
        historyId: id,
        revision: record.revision,
        identification: selected.identification,
      };
      const plan = await this.backend.previewTransfer(command, signal);
      for (const file of plan.files) {
        if (files.has(file.sourceKey)) {
          throw new ConflictError("所选记录包含重复或重叠的源文件，请只保留一条");
        }
        files.add(file.sourceKey);
        if (targets.has(file.targetKey)) {
          throw new ConflictError(
            `多个源文件指向同一目标 ${file.targetFilename}，请逐条修正季集映射后重新预览`,
          );
        }
        targets.add(file.targetKey);
      }
      if (files.size > 200) {
        throw new ConflictError("一次重新整理最多包含 200 个文件，请分批选择");
      }
      result.push({
        ...command,
        filename: record.filename,
        sourceKey: record.sourceKey,
        plan,
        state: "ready",
        message: "等待确认",
      });
    }
    return result;
  }
}
