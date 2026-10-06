import { preferencesSchema } from "@mp-pi/contracts";
import { ConflictError } from "../core/errors.js";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "../core/tools.js";
import type { ToolServices } from "./types.js";

export function createPreferenceTools(services: ToolServices): ToolDefinition[] {
  const { store } = services;
  const empty = z.strictObject({});
  return [
    defineTool(
      "get_preferences",
      "Read the user's saved defaults. Request conditions are separate.",
      empty,
      (_parameters, context) => store.getPreferences(context.userId),
    ),
    defineTool(
      "remember_preferences",
      "Save future defaults ONLY when the user explicitly asks to remember them or says future/default/以后/默认. Never store one-request requirements.",
      z.strictObject({ preferences: preferencesSchema, reason: z.string().min(1) }),
      ({ preferences, reason }, context) => {
        if (!/(以后|今后|默认|记住|长期|future|default|remember)/i.test(context.inputText)) {
          throw new ConflictError("用户尚未明确要求保存为长期偏好");
        }
        const value = { ...store.getPreferences(context.userId), ...preferences };
        store.setPreferences(context.userId, value, `${context.inputText}\n${reason}`);
        return value;
      },
    ),
    defineTool(
      "forget_preferences",
      "Clear saved defaults when the user explicitly requests it.",
      empty,
      (_parameters, context) => {
        if (
          !/(清除|删除|忘记|重置|clear|forget|reset).*(偏好|默认|记忆|preferences|defaults|memory)/i.test(
            context.inputText,
          )
        ) {
          throw new ConflictError("请明确要求清除偏好");
        }
        store.setPreferences(context.userId, {}, context.inputText);
        return {};
      },
    ),
  ];
}
