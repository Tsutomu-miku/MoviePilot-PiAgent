import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "../core/tools.js";
import type { ToolServices } from "./types.js";

export function createSkillTools(services: ToolServices): ToolDefinition[] {
  const { skills } = services;

  return [
    defineTool(
      "read_skill",
      "Read an advertised skill by name before using its workflow.",
      z.strictObject({ name: z.string() }),
      ({ name }, context) => skills.read(context.userId, name),
    ),
  ];
}
