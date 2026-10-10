import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolServices } from "./types.js";
import { createSkillTools } from "./skills.js";
import { createPreferenceTools } from "./preferences.js";
import { createMediaTools } from "./media.js";
import { createTaskTools } from "./tasks.js";
import { createMoviePilotTools } from "./moviepilot.js";
import { createMikanTools } from "./mikan.js";
import { createCloudTools } from "./cloud.js";

export function createTools(services: ToolServices): ToolDefinition[] {
  return [
    ...createSkillTools(services),
    ...createPreferenceTools(services),
    ...createMediaTools(services),
    ...createMikanTools(services),
    ...createCloudTools(services),
    ...createTaskTools(services),
    ...createMoviePilotTools(services),
  ];
}
