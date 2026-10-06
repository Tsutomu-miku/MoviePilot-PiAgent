import { z } from "zod";
import { resolve } from "node:path";

const boolean = z.enum(["true", "false"]).transform((value) => value === "true");
const environmentSchema = z
  .object({
    HOST: z.string().default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(8787),
    AGENT_DATA_DIR: z.string().default("./data"),
    AGENT_OWNER_ID: z.string().min(1).default("owner"),
    WEB_AUTH_TOKEN: z.string().min(32),
    AGENT_PROVIDER: z.string().min(1),
    AGENT_MODEL: z.string().min(1),
    AGENT_API_KEY: z.string().min(1).optional(),
    AGENT_BASE_URL: z.url().optional(),
    AGENT_CONTEXT_WINDOW: z.coerce.number().int().positive().default(128000),
    AGENT_MAX_TOKENS: z.coerce.number().int().positive().default(8192),
    MOVIEPILOT_URL: z.url(),
    MOVIEPILOT_ACCESS_TOKEN: z.string().min(1).optional(),
    MOVIEPILOT_USERNAME: z.string().min(1).optional(),
    MOVIEPILOT_PASSWORD: z.string().min(1).optional(),
    MOVIEPILOT_DOWNLOADER: z.string().min(1).optional(),
    MOVIEPILOT_SAVE_PATH: z.string().min(1).optional(),
    MOVIEPILOT_UTC_OFFSET_MINUTES: z.coerce.number().int().min(-720).max(840).default(480),
    TASK_POLL_SECONDS: z.coerce.number().int().min(5).default(30),
    FEISHU_ENABLED: boolean.default(false),
    FEISHU_APP_ID: z.string().min(1).optional(),
    FEISHU_APP_SECRET: z.string().min(1).optional(),
    FEISHU_ALLOWED_OPEN_IDS: z.string().default(""),
    FEISHU_ALLOWED_GROUP_IDS: z.string().default(""),
  })
  .superRefine((value, context) => {
    if (
      !value.MOVIEPILOT_ACCESS_TOKEN &&
      !(value.MOVIEPILOT_USERNAME && value.MOVIEPILOT_PASSWORD)
    ) {
      context.addIssue({
        code: "custom",
        message: "配置 MoviePilot 令牌或账号密码",
        path: ["MOVIEPILOT_ACCESS_TOKEN"],
      });
    }
    if (
      value.FEISHU_ENABLED &&
      !(value.FEISHU_APP_ID && value.FEISHU_APP_SECRET && value.FEISHU_ALLOWED_OPEN_IDS.trim())
    ) {
      context.addIssue({
        code: "custom",
        message: "启用飞书需要应用凭据和用户 open_id 白名单",
        path: ["FEISHU_ENABLED"],
      });
    }
  });

export function readConfig(environment: NodeJS.ProcessEnv, workspaceDir: string) {
  const value = environmentSchema.parse(environment);
  return {
    ...value,
    AGENT_DATA_DIR: resolve(workspaceDir, value.AGENT_DATA_DIR),
    feishuOpenIds: value.FEISHU_ALLOWED_OPEN_IDS.split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    feishuGroupIds: value.FEISHU_ALLOWED_GROUP_IDS.split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  };
}
export type Config = ReturnType<typeof readConfig>;
