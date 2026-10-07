import { z } from "zod";
import { mikanQuerySchema } from "@mp-pi/contracts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "../core/tools.js";
import type { ToolServices } from "./types.js";

export function createMikanTools({ mikan, tasks }: ToolServices): ToolDefinition[] {
  return [
    defineTool(
      "search_mikan",
      "Search the configured Mikan site's public RSS directly using the supplied title keyword and optional release group. Bypasses MoviePilot catalog matching. Returns a snapshot of the feed, not the site's entire catalog.",
      mikanQuerySchema,
      (query, context, signal) => mikan.search(query, context, signal),
    ),
    defineTool(
      "list_mikan_resources",
      "Read another page of the current Mikan snapshot.",
      z.strictObject({ searchId: z.string().uuid(), offset: z.number().int().nonnegative() }),
      ({ searchId, offset }, context) => {
        const view = mikan.listResources(context, searchId, offset);
        context.publish(view);
        return view;
      },
    ),
    defineTool(
      "prepare_mikan_download",
      "Resolve selected Mikan torrents and preview a batch to 115. Uses stable resource IDs from search_mikan; does not submit downloads.",
      z.strictObject({
        searchId: z.string().uuid(),
        resourceIds: z
          .array(z.string().regex(/^[a-f0-9]{64}$/))
          .min(1)
          .max(20),
      }),
      ({ searchId, resourceIds }, context, signal) =>
        tasks.prepareMikanDownload(searchId, resourceIds, context, signal),
    ),
  ];
}
