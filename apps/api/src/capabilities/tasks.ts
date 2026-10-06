import { destinationSchema } from "@mp-pi/contracts";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "../core/tools.js";
import type { ToolServices } from "./types.js";

export function createTaskTools(services: ToolServices): ToolDefinition[] {
  const { tasks } = services;
  const empty = z.strictObject({});
  return [
    defineTool(
      "prepare_download",
      "Preview one selected stable resource ID and destination. Does not submit anything.",
      z.strictObject({
        searchId: z.string().uuid(),
        resourceId: z.string(),
        destination: destinationSchema,
      }),
      ({ searchId, resourceId, destination }, context, signal) =>
        tasks.prepareDownload(searchId, resourceId, destination, context, signal),
    ),
    defineTool(
      "prepare_links",
      "Preview pasted public torrent URLs or magnet links for 115. Local file upload is not supported.",
      z.strictObject({ links: z.string().min(1).max(32000) }),
      ({ links }, context, signal) => tasks.prepareLinks(links, context, signal),
    ),
    defineTool(
      "confirm_task",
      "Commit only the task explicitly approved in a NEW user message or confirmation button. Cannot approve your own proposal.",
      z.strictObject({ taskId: z.string().uuid(), token: z.string().uuid() }),
      ({ taskId, token }, context, signal) => tasks.confirm(taskId, token, context, signal),
    ),
    defineTool(
      "cancel_task",
      "Cancel a pending operation in this conversation.",
      z.strictObject({ taskId: z.string().uuid() }),
      ({ taskId }, context) => {
        const view = tasks.cancel(context, taskId);
        context.publish(view);
        return view;
      },
    ),
    defineTool(
      "get_tasks",
      "Read this conversation's authoritative tasks. Submitted is not downloaded; downloaded is not imported.",
      empty,
      (_parameters, context) => {
        const view = tasks.list(context);
        context.publish(view);
        return view;
      },
    ),
    defineTool(
      "prepare_subscription",
      "Preview a MoviePilot native subscription. TV subscriptions require a season.",
      z.strictObject({ mediaKey: z.string(), season: z.number().int().positive().optional() }),
      ({ mediaKey, season }, context) => tasks.prepareSubscription(mediaKey, season, context),
    ),
    defineTool(
      "prepare_subscription_change",
      "Preview pause, resume or delete of a native subscription. Requires subsequent user confirmation.",
      z.strictObject({
        subscriptionId: z.string().regex(/^\d+$/),
        operation: z.enum(["pause", "resume", "delete"]),
      }),
      ({ subscriptionId, operation }, context, signal) =>
        tasks.prepareSubscriptionChange(subscriptionId, operation, context, signal),
    ),
  ];
}
