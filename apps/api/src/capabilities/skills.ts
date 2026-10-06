import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { ConflictError } from "../core/errors.js";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "../core/tools.js";
import type { ToolServices } from "./types.js";

export function createSkillTools(services: ToolServices): ToolDefinition[] {
  const { loader } = services;

  return [
    defineTool(
      "read_skill",
      "Read an advertised skill by name before using its workflow.",
      z.strictObject({ name: z.string() }),
      async ({ name }) => {
        const skill = loader.getSkills().skills.find((item) => item.name === name);
        if (!skill) {
          throw new ConflictError("未找到该 Skill");
        }
        const root = await realpath(services.skillsDir);
        const file = await realpath(skill.filePath);
        const path = relative(root, file);
        if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
          throw new ConflictError("Skill 路径超出项目目录");
        }
        return { name, content: await readFile(file, "utf8") };
      },
    ),
  ];
}
