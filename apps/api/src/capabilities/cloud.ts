import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "../core/tools.js";
import type { ToolServices } from "./types.js";

export function createCloudTools({ backend }: ToolServices): ToolDefinition[] {
  return [
    defineTool(
      "get_115_status",
      "Read the current 115 RSS offline plugin (CloudAutoSearch): offline login check and timestamp, configured save folder, RSS enabled flag and whether a job is running. refresh=true checks the offline service now without creating a download. RSS enabled=false only pauses scheduled RSS; manual 115 submissions still work. This plugin submits directly to 115 and does not require a MoviePilot downloader connection. A past failed task describes that attempt, not the current plugin status.",
      z.strictObject({ refresh: z.boolean().default(true) }),
      async ({ refresh }, _context, signal) => ({
        source: "CloudAutoSearch",
        checkedNow: refresh,
        ...(await backend.get115Status(refresh, signal)),
      }),
    ),
    defineTool(
      "get_115_tasks",
      "Read actual 115 offline tasks through P115StrmHelper using that plugin's configured 115 account. Includes completed tasks. This is a separate source from CloudAutoSearch's submission batch and from MoviePilot's ordinary downloader list.",
      z.strictObject({}),
      async (_parameters, _context, signal) => ({
        source: "P115StrmHelper",
        tasks: await backend.get115Tasks(signal),
      }),
    ),
  ];
}
