import { z } from "zod";

const text = z
  .string()
  .nullable()
  .transform((value) => value ?? "");
export const mpMediaSchema = z
  .object({
    source: z.enum(["themoviedb", "douban", "bangumi", "anilist"]),
    media_id: z.string().min(1),
    title: z.string().min(1),
    type: z.enum(["电影", "电视剧"]),
    year: text,
    overview: text,
    tmdb_id: z.number().nullable(),
    douban_id: z.string().nullable(),
    bangumi_id: z.number().nullable(),
    anilist_id: z.number().nullable(),
  })
  .passthrough();
export type MpMedia = z.infer<typeof mpMediaSchema>;
export const mpTorrentSchema = z
  .object({
    title: z.string().min(1),
    description: text,
    size: z.number().nonnegative(),
    seeders: z.number().nullable(),
    site: z.number().nullable(),
    site_name: text,
    enclosure: z.string().nullable(),
    site_cookie: z.string().nullable().optional(),
  })
  .passthrough();
export type MpTorrent = z.infer<typeof mpTorrentSchema>;
export const mpContextSchema = z.object({
  torrent_info: mpTorrentSchema,
  media_info: mpMediaSchema.nullable(),
  meta_info: z
    .object({
      begin_season: z.number().nullable().optional(),
      begin_episode: z.number().nullable().optional(),
      end_episode: z.number().nullable().optional(),
    })
    .passthrough(),
});
export type MpContext = z.infer<typeof mpContextSchema>;
export const mpEnvelopeSchema = z.object({
  success: z.boolean(),
  message: z.string().nullable().optional(),
  data: z.unknown().optional(),
});
export const activeDownloadSchema = z.object({
  hash: z.string(),
  title: text,
  state: text,
  progress: z
    .number()
    .nullable()
    .transform((value) => value ?? 0),
});
export type ActiveDownload = z.infer<typeof activeDownloadSchema>;
export const offlineTaskSchema = z.object({
  info_hash: z.string(),
  name: z.string(),
  status: z.number(),
  percent: z.number(),
});
export type OfflineTask = z.infer<typeof offlineTaskSchema>;
export const offlinePluginStatusSchema = z.object({
  version: z.string(),
  enabled: z.boolean(),
  running: z.boolean(),
  logged_in: z.boolean(),
  credential_saved: z.boolean(),
  target_folder: z.string(),
  rss_count: z.number().int().nonnegative(),
  login_status: z.object({
    state: z.enum(["missing", "unchecked", "valid", "invalid", "error"]),
    message: z.string(),
    checked_at: z.string().optional(),
  }),
});
export type OfflinePluginStatus = z.infer<typeof offlinePluginStatusSchema>;
export const submissionSchema = z.object({
  id: z.string(),
  status: z.string(),
  submitted: z.number(),
  failed: z.number(),
  duplicated: z.number(),
  results: z.array(
    z.object({ index: z.number(), title: z.string(), status: z.string(), message: z.string() }),
  ),
});
export type OfflineSubmission = z.infer<typeof submissionSchema>;
export const subscriptionSchema = z
  .object({ id: z.number(), name: z.string(), season: z.number().nullable(), state: z.string() })
  .passthrough();
export type Subscription = z.infer<typeof subscriptionSchema>;
export const transferHistorySchema = z
  .object({
    download_hash: z.string().nullable(),
    status: z.boolean(),
    date: z.string(),
    media_source: z.string().nullable(),
    media_id: z.string().nullable(),
  })
  .passthrough();
export type TransferHistory = z.infer<typeof transferHistorySchema>;
