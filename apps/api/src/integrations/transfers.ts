import { z } from "zod";
import { mediaSummarySchema, transferSummarySchema } from "@mp-pi/contracts";

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
