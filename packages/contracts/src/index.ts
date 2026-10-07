import { z } from "zod";

export const destinationSchema = z.enum(["moviepilot", "115"]);
export const criteriaSchema = z.strictObject({
  resolution: z.enum(["2160p", "1080p", "1080i", "720p"]).optional(),
  channels: z.enum(["2.0", "5.1", "7.1"]).optional(),
  audio: z.enum(["Atmos", "TrueHD", "DTS-HD", "DTS", "DDP", "AC3", "AAC", "FLAC"]).optional(),
  subtitle: z.enum(["CHS", "CHT", "JP", "EN"]).optional(),
  source: z.enum(["WEB-DL", "WEBRip", "Remux", "BluRay", "HDTV"]).optional(),
  maxSizeGiB: z.number().positive().max(5000).optional(),
  minSeeders: z.number().int().nonnegative().optional(),
  noDolbyVision: z.boolean().optional(),
  noHdr: z.boolean().optional(),
  exclude: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  preferResolution: z.enum(["2160p", "1080p", "1080i", "720p"]).optional(),
  season: z.number().int().positive().max(100).optional(),
  episodes: z.array(z.number().int().positive().max(10000)).max(1000).optional(),
});
export type Criteria = z.infer<typeof criteriaSchema>;
export type Destination = z.infer<typeof destinationSchema>;
export const preferencesSchema = criteriaSchema
  .omit({ season: true, episodes: true })
  .extend({ destination: destinationSchema.optional() });
export type Preferences = z.infer<typeof preferencesSchema>;

export const skillNameSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const skillSummarySchema = z.object({
  name: skillNameSchema,
  description: z.string(),
  source: z.enum(["builtin", "personal"]),
  enabled: z.boolean(),
});
export type SkillSummary = z.infer<typeof skillSummarySchema>;
export const skillDetailSchema = skillSummarySchema.extend({ content: z.string() });
export type SkillDetail = z.infer<typeof skillDetailSchema>;
export const skillWriteSchema = z.strictObject({
  content: z.string().min(1).max(32000),
  enabled: z.boolean(),
});
export type SkillWrite = z.infer<typeof skillWriteSchema>;
export const mikanQuerySchema = z.strictObject({
  keyword: z.string().trim().min(1).max(120),
  group: z.string().trim().min(1).max(120).optional(),
  resolution: criteriaSchema.shape.resolution,
  subtitle: criteriaSchema.shape.subtitle,
});
export type MikanQuery = z.infer<typeof mikanQuerySchema>;

export const mediaSummarySchema = z.object({
  key: z.string(),
  title: z.string(),
  year: z.string(),
  type: z.enum(["电影", "电视剧"]),
  source: z.enum(["themoviedb", "douban", "bangumi", "anilist"]),
  id: z.string(),
  overview: z.string(),
});
export type MediaSummary = z.infer<typeof mediaSummarySchema>;
export const tagsSchema = z.object({
  resolution: z.string().optional(),
  channels: z.string().optional(),
  audio: z.array(z.string()),
  subtitles: z.array(z.string()),
  source: z.string().optional(),
  dolbyVision: z.boolean(),
  hdr: z.boolean(),
  season: z.number().optional(),
  episodes: z.array(z.number()).optional(),
});
export const resourceSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  site: z.string(),
  sizeGiB: z.number(),
  seeders: z.number(),
  tags: tagsSchema,
});
export type ResourceSummary = z.infer<typeof resourceSummarySchema>;
export const mikanResourceSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string(),
  sourceUrl: z.url({ protocol: /^https?$/ }),
  sizeGiB: z.number().nonnegative(),
  publishedAt: z.string(),
  group: z.string().optional(),
  tags: tagsSchema,
});
export type MikanResourceSummary = z.infer<typeof mikanResourceSchema>;
export const taskStateSchema = z.enum([
  "awaiting_confirmation",
  "submitting",
  "submitted",
  "downloading",
  "downloaded",
  "imported",
  "completed",
  "failed",
  "unknown",
  "cancelled",
]);
export type TaskState = z.infer<typeof taskStateSchema>;
export const transferItemStateSchema = z.enum([
  "ready",
  "cancelled",
  "submitting",
  "completed",
  "failed",
  "unknown",
]);
export const transferSummarySchema = z.object({
  id: z.string().regex(/^\d+$/),
  filename: z.string(),
  title: z.string(),
  error: z.string(),
  date: z.string(),
  identification: z
    .object({
      media: mediaSummarySchema,
      season: z.number().optional(),
      episodes: z.array(z.number()).optional(),
    })
    .optional(),
});
export type TransferSummary = z.infer<typeof transferSummarySchema>;
export const transferTaskItemSchema = z.object({
  historyId: z.string(),
  filename: z.string(),
  files: z.array(z.object({ filename: z.string(), targetFilename: z.string() })),
  title: z.string(),
  state: transferItemStateSchema,
  message: z.string(),
  cleanupTarget: z.boolean(),
});
export const taskSummarySchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  kind: z.enum(["download", "subscription", "subscription_change", "transfer_retry"]),
  title: z.string(),
  destination: destinationSchema,
  state: taskStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  progress: z.number().optional(),
  message: z.string(),
  confirmationToken: z.string().optional(),
  playUrl: z.string().optional(),
  transferItems: z.array(transferTaskItemSchema).optional(),
  downloadItems: z.array(mikanResourceSchema).optional(),
});
export type TaskSummary = z.infer<typeof taskSummarySchema>;
export const viewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mikan"),
    searchId: z.string().uuid(),
    query: mikanQuerySchema,
    searchUrl: z.url({ protocol: /^https?$/ }),
    received: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    items: z.array(mikanResourceSchema),
  }),
  z.object({
    kind: z.literal("transfer_failures"),
    title: z.string().optional(),
    searchId: z.string().uuid(),
    page: z.number().int(),
    count: z.number().int(),
    total: z.number().int(),
    items: z.array(transferSummarySchema),
  }),
  z.object({ kind: z.literal("media"), items: z.array(mediaSummarySchema) }),
  z.object({
    kind: z.literal("resources"),
    searchId: z.string(),
    media: mediaSummarySchema,
    criteria: criteriaSchema,
    total: z.number(),
    items: z.array(resourceSummarySchema),
  }),
  z.object({ kind: z.literal("confirmation"), task: taskSummarySchema }),
  z.object({ kind: z.literal("tasks"), items: z.array(taskSummarySchema) }),
  z.object({
    kind: z.literal("subscriptions"),
    items: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        season: z.number().optional(),
        state: z.string(),
      }),
    ),
  }),
  z.object({
    kind: z.literal("library"),
    title: z.string(),
    exists: z.boolean(),
    episodes: z.record(z.string(), z.array(z.number())).optional(),
    playUrl: z.string().optional(),
  }),
]);
export type View = z.infer<typeof viewSchema>;
export const actionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("mikan_search"), query: mikanQuerySchema }),
  z.strictObject({
    type: z.literal("prepare_mikan_download"),
    searchId: z.string().uuid(),
    resourceIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/))
      .min(1)
      .max(20),
  }),
  z.strictObject({
    type: z.literal("transfer_failures"),
    title: z.string().max(200).optional(),
    page: z.number().int().positive().default(1),
  }),
  z.strictObject({
    type: z.literal("prepare_transfer_retry"),
    searchId: z.string().uuid(),
    historyIds: z.array(z.string().regex(/^\d+$/)).min(1).max(20),
  }),
  z.strictObject({
    type: z.literal("resources"),
    mediaKey: z.string().min(1).max(100),
    criteria: criteriaSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("filter"),
    searchId: z.string().uuid(),
    criteria: criteriaSchema,
  }),
  z.strictObject({
    type: z.literal("prepare_download"),
    searchId: z.string().uuid(),
    resourceId: z.string().min(1).max(100),
    destination: destinationSchema,
  }),
  z.strictObject({ type: z.literal("prepare_links"), links: z.string().min(1).max(32000) }),
  z.strictObject({
    type: z.literal("confirm"),
    taskId: z.string().uuid(),
    token: z.string().uuid(),
  }),
  z.strictObject({ type: z.literal("cancel"), taskId: z.string().uuid() }),
  z.strictObject({
    type: z.literal("subscribe"),
    mediaKey: z.string().min(1).max(100),
    season: z.number().int().positive().optional(),
  }),
  z.strictObject({
    type: z.literal("subscription_change"),
    subscriptionId: z.string().regex(/^\d+$/),
    operation: z.enum(["pause", "resume", "delete"]),
  }),
]);
export type UserAction = z.infer<typeof actionSchema>;
export const messageInputSchema = z
  .strictObject({
    requestId: z.string().min(1).max(200),
    text: z.string().max(32000),
    action: actionSchema.optional(),
    skillName: skillNameSchema.optional(),
  })
  .refine((value) => value.text.trim().length > 0 || value.action !== undefined, "消息不能为空");
export type MessageInput = z.infer<typeof messageInputSchema>;
export interface AgentInput extends MessageInput {
  userId: string;
  conversationId: string;
}
export const agentReplySchema = z.object({
  conversationId: z.string(),
  requestId: z.string(),
  text: z.string(),
  views: z.array(viewSchema),
});
export type AgentReply = z.infer<typeof agentReplySchema>;
export const uiEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text_start") }),
  z.object({ type: z.literal("text_delta"), text: z.string() }),
  z.object({ type: z.literal("tool_start"), name: z.string() }),
  z.object({ type: z.literal("tool_end"), name: z.string(), failed: z.boolean() }),
  z.object({ type: z.literal("reply"), reply: agentReplySchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type UiEvent = z.infer<typeof uiEventSchema>;
export interface UiAdapter {
  publish(input: AgentInput, event: UiEvent): void;
}
export const conversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof conversationSchema>;
export const displayMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  views: z.array(viewSchema),
  createdAt: z.string(),
});
export type DisplayMessage = z.infer<typeof displayMessageSchema>;
export function messageId(requestId: string, role: DisplayMessage["role"]): string {
  return `${requestId}:${role}`;
}
export const stateLabels: Record<TaskState, string> = {
  awaiting_confirmation: "等待确认",
  submitting: "正在提交",
  submitted: "已提交",
  downloading: "下载中",
  downloaded: "下载完成",
  imported: "已入库",
  completed: "已完成",
  failed: "失败",
  unknown: "待核对",
  cancelled: "已取消",
};

export { decodeUiStream } from "./stream.js";
