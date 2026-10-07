import type {
  Criteria,
  MediaSummary,
  ResourceSummary,
  TaskSummary,
  MikanQuery,
  MikanResourceSummary,
} from "@mp-pi/contracts";
import type { MpMedia, MpTorrent } from "../integrations/moviepilot-contracts.js";
import type { TransferCommand, TransferPage, TransferPlan } from "../integrations/transfers.js";

export type { Criteria, Destination, View, UserAction, Preferences } from "@mp-pi/contracts";
export interface Identity {
  userId: string;
  conversationId: string;
}
export interface Media extends MediaSummary {
  raw: MpMedia;
}
export interface Resource extends ResourceSummary {
  torrent: MpTorrent;
  infoHash?: string;
}
export interface SearchSnapshot {
  id: string;
  media: Media;
  criteria: Criteria;
  resources: Resource[];
  createdAt: string;
}
export interface TransferSnapshot extends TransferPage {
  id: string;
}
export interface MikanResource extends MikanResourceSummary {
  downloadUrl: string;
}
export interface MikanSnapshot {
  id: string;
  query: MikanQuery;
  searchUrl: string;
  received: number;
  resources: MikanResource[];
}
export interface TransferRetryItem extends TransferCommand {
  filename: string;
  sourceKey: string;
  plan: TransferPlan;
  state: "ready" | "submitting" | "completed" | "failed" | "unknown";
  message: string;
}
export type TaskPayload =
  | { kind: "transfer_retry"; items: TransferRetryItem[] }
  | {
      kind: "resource";
      media: Media;
      resource: Resource;
      criteria: Criteria;
      libraryBefore: boolean;
      resolvedLinks: string[];
      infoHashes: string[];
    }
  | {
      kind: "links";
      links: string[];
      infoHashes: string[];
      mikan?: { searchId: string; resources: MikanResourceSummary[] };
    }
  | { kind: "subscription"; media: Media; season?: number }
  | {
      kind: "subscription_change";
      subscriptionId: string;
      operation: "pause" | "resume" | "delete";
    };
export interface Task extends Omit<TaskSummary, "confirmationToken">, Identity {
  confirmationToken: string;
  expiresAt: string;
  preparedRequestId: string;
  submissionKey: string;
  payload: TaskPayload;
  searchId?: string;
  resourceId?: string;
  backendId?: string;
  notifiedState?: TaskSummary["state"];
}
export interface ToolContext extends Identity {
  requestId: string;
  inputText: string;
  approvedTaskIds: Set<string>;
  publish(view: import("@mp-pi/contracts").View): void;
}

export function publicMedia({ raw: _raw, ...media }: Media): MediaSummary {
  return media;
}
export function publicResource({
  torrent: _torrent,
  infoHash: _hash,
  ...resource
}: Resource): ResourceSummary {
  return resource;
}
export function publicTask(task: Task): TaskSummary {
  return {
    id: task.id,
    conversationId: task.conversationId,
    kind: task.kind,
    title: task.title,
    destination: task.destination,
    state: task.state,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    progress: task.progress,
    message: task.message,
    playUrl: task.playUrl,
    confirmationToken: task.state === "awaiting_confirmation" ? task.confirmationToken : undefined,
    downloadItems: task.payload.kind === "links" ? task.payload.mikan?.resources : undefined,
    transferItems:
      task.payload.kind === "transfer_retry"
        ? task.payload.items.map((item) => ({
            historyId: item.historyId,
            filename: item.filename,
            files: item.plan.files.map((file) => ({
              filename: file.filename,
              targetFilename: file.targetFilename,
            })),
            title: item.plan.files[0]!.title,
            state: task.state === "cancelled" ? "cancelled" : item.state,
            message: task.state === "cancelled" ? "已取消，未执行" : item.message,
            cleanupTarget: item.plan.cleanupTarget,
          }))
        : undefined,
  };
}
