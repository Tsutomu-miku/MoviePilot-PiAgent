import { AsyncLocalStorage } from "node:async_hooks";
import { Type, type TSchema } from "typebox";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolContext } from "../domain/types.js";

export const toolContext = new AsyncLocalStorage<ToolContext>();

export function defineTool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  execute: (
    parameters: z.infer<S>,
    context: ToolContext,
    signal?: AbortSignal,
  ) => unknown | Promise<unknown>,
): ToolDefinition {
  const parameters = Type.Unsafe<z.infer<S>>(z.toJSONSchema(schema, { io: "input" }) as TSchema);
  return {
    name,
    label: name,
    description,
    parameters,
    execute: async (_id, input, signal) => {
      const context = toolContext.getStore();
      if (!context) {
        throw new Error("Tool execution requires an active request");
      }
      const result = await execute(schema.parse(input), context, signal);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
