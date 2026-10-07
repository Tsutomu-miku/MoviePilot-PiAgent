import { z } from "zod";
import { mediaSummarySchema, transferSummarySchema } from "@mp-pi/contracts";

export const transferAssignmentSchema = z.strictObject({
  historyId: z.string().regex(/^\d+$/),
  mediaKey: z.string(),
  season: z.number().int().min(0).max(100).optional().describe("0 means specials"),
  episodes: z
    .array(z.number().int().min(1).max(10000))
    .min(1)
    .max(1000)
    .refine(
      (episodes) =>
        episodes.every((episode, index) => index === 0 || episode === episodes[index - 1]! + 1),
      "一个文件的集号必须连续且递增；不同文件请分别填写 historyId 和 episodes",
    )
    .optional()
    .describe(
      "Episodes contained in this ONE file. [3] means episode 3; [3,4] means a combined episode 3–4 file. Never distribute this array across files.",
    ),
});
export type TransferAssignment = z.infer<typeof transferAssignmentSchema>;

export const transferIdentificationSchema = z.object({
  media: mediaSummarySchema,
  season: z.number().int().min(0).max(100).optional(),
  episodes: z.array(z.number().int().min(1).max(10000)).min(1).max(1000).optional(),
});
export type TransferIdentification = z.infer<typeof transferIdentificationSchema>;
export const transferRecordSchema = transferSummarySchema.omit({ identification: true }).extend({
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  sourceKey: z.string().regex(/^[a-f0-9]{64}$/),
  cleanupTarget: z.boolean(),
});
export type TransferRecord = z.infer<typeof transferRecordSchema>;
export const transferPlanSchema = z.object({
  planHash: z.string().regex(/^[a-f0-9]{64}$/),
  cleanupTarget: z.boolean(),
  files: z
    .array(
      z.object({
        sourceKey: z.string().regex(/^[a-f0-9]{64}$/),
        targetKey: z.string().regex(/^[a-f0-9]{64}$/),
        filename: z.string(),
        targetFilename: z.string(),
        title: z.string(),
        season: z.number().nullable(),
        episode: z.number().nullable(),
      }),
    )
    .min(1)
    .max(200),
});
export type TransferPlan = z.infer<typeof transferPlanSchema>;
export interface TransferCommand {
  historyId: string;
  revision: string;
  identification?: TransferIdentification;
}
export interface TransferQuery {
  title?: string;
  page: number;
  count: number;
}
export interface TransferPage extends TransferQuery {
  total: number;
  items: z.infer<typeof transferSummarySchema>[];
}
