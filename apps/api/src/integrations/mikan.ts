import { z } from "zod";

export const mikanReleaseSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  title: z.string().min(1),
  sourceUrl: z.url({ protocol: /^https?$/ }),
  downloadUrl: z.url({ protocol: /^https?$/ }),
  size: z.number().int().nonnegative(),
  publishedAt: z.string(),
});
export const mikanPageSchema = z.object({
  searchUrl: z.url({ protocol: /^https?$/ }),
  received: z.number().int().nonnegative(),
  items: z.array(mikanReleaseSchema),
});
export type MikanPage = z.infer<typeof mikanPageSchema>;
