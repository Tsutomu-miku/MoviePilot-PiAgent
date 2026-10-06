import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolServices } from "./types.js";
import { createSkillTools } from "./skills.js";
import { createPreferenceTools } from "./preferences.js";
import { createMediaTools } from "./media.js";
import { createTaskTools } from "./tasks.js";

export function createTools(services: ToolServices): ToolDefinition[] {
  return [
    ...createSkillTools(services),
    ...createPreferenceTools(services),
    ...createMediaTools(services),
    ...createTaskTools(services),
  ];
}
