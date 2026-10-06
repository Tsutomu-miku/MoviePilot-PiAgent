import { criteriaSchema, type View } from "@mp-pi/contracts";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "../core/tools.js";
import type { ToolServices } from "./types.js";

export function createMediaTools(services: ToolServices): ToolDefinition[] {
  const { search, backend } = services;
  const empty = z.strictObject({});
  return [
    defineTool(
      "search_media",
      "Search MoviePilot's media catalog by title. Returns canonical media keys.",
      z.strictObject({ query: z.string().min(1).max(200) }),
      ({ query }, context, signal) => search.searchMedia(query, context, signal),
    ),
    defineTool(
      "search_resources",
      "Search resources for a media key from this conversation. All requirements are applied before ranking and pagination.",
      z.strictObject({ mediaKey: z.string(), criteria: criteriaSchema }),
      ({ mediaKey, criteria }, context, signal) =>
        search.searchResources(mediaKey, criteria, context, signal),
    ),
    defineTool(
      "update_requirements",
      "Replace the full current criteria and invalidate prior confirmations. Include existing conditions to retain them; omit a field to clear it.",
      z.strictObject({ searchId: z.string().uuid(), criteria: criteriaSchema }),
      ({ searchId, criteria }, context, signal) =>
        search.filter(searchId, criteria, context, signal),
    ),
    defineTool(
      "list_resources",
      "Read a page of the current search snapshot. Never use a displayed ordinal as resource ID.",
      z.strictObject({ searchId: z.string().uuid(), offset: z.number().int().nonnegative() }),
      ({ searchId, offset }, context) => {
        const view = search.listResources(context, searchId, offset);
        context.publish(view);
        return view;
      },
    ),
    defineTool(
      "get_downloading",
      "Read active MoviePilot downloads. This list excludes completed downloads.",
      empty,
      (_parameters, _context, signal) => backend.getDownloading(signal),
    ),
    defineTool(
      "check_library",
      "Check actual media-library presence. Opening a library URL does not prove playback works.",
      z.strictObject({ mediaKey: z.string(), criteria: criteriaSchema }),
      async ({ mediaKey, criteria }, context, signal) => {
        const media = search.getMedia(context, mediaKey);
        const result = await backend.checkLibrary(media, criteria, signal);
        const view: View = { kind: "library", title: media.title, ...result };
        context.publish(view);
        return view;
      },
    ),
    defineTool(
      "list_subscriptions",
      "Read MoviePilot native subscriptions; this does not include Mikan RSS subscriptions.",
      empty,
      async (_parameters, context, signal) => {
        const items = await backend.listSubscriptions(signal);
        const view: View = {
          kind: "subscriptions",
          items: items.map((item) => ({
            id: String(item.id),
            title: item.name,
            season: item.season ?? undefined,
            state: item.state,
          })),
        };
        context.publish(view);
        return view;
      },
    ),
  ];
}
