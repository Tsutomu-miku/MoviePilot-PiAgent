import { z } from "zod";
import { mikanQuerySchema } from "@mp-pi/contracts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "../core/tools.js";
import type { ToolServices } from "./types.js";
import { mikanAgentPage } from "../services/mikan-search-service.js";

export function createMikanTools({ mikan, tasks }: ToolServices): ToolDefinition[] {
  return [
    defineTool(
      "search_mikan",
      "Search the configured Mikan site's public RSS directly using the supplied title keyword and optional release group. Bypasses MoviePilot catalog matching. Returns a feed snapshot with short resource refs (m1, m2, ...), scoped to searchId, for download previews.",
      mikanQuerySchema,
      async (query, context, signal) => mikanAgentPage(await mikan.search(query, context, signal)),
    ),
    defineTool(
      "list_mikan_resources",
      "Read another page of the current Mikan snapshot. Resource refs are stable across pages and refer to the same searchId.",
      z.strictObject({ searchId: z.string().uuid(), offset: z.number().int().nonnegative() }),
      ({ searchId, offset }, context) => {
        const view = mikan.listResources(context, searchId, offset);
        context.publish(view);
        return mikanAgentPage(view);
      },
    ),
    defineTool(
      "prepare_mikan_download",
      "Resolve selected Mikan torrents and preview a batch to 115. Use the short ref values (m1, m21, ...) returned by search_mikan or list_mikan_resources in resourceRefs. The server resolves them to torrent IDs. Does not submit downloads.",
      z.strictObject({
        searchId: z.string().uuid(),
        resourceRefs: z
          .array(z.string().regex(/^m[1-9]\d*$/))
          .min(1)
          .max(20),
      }),
      ({ searchId, resourceRefs }, context, signal) => {
        const resourceIds = mikan.resourceIdsForRefs(context, searchId, resourceRefs);
        return tasks.prepareMikanDownload(searchId, resourceIds, context, signal);
      },
    ),
  ];
}
