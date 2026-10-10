import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createLarkChannel } from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
import { readConfig } from "./config.js";
import { AgentRuntime } from "./core/runtime.js";
import { configureModel } from "./core/model.js";
import { MoviePilotClient } from "./integrations/moviepilot.js";
import { TaskTracker } from "./services/task-tracker.js";
import { FeishuUi } from "./ui/feishu.js";
import { createApp } from "./http/app.js";

process.umask(0o077);
const projectDir = process.cwd();
const config = readConfig(process.env, resolve(projectDir, "../.."));
const models = await ModelRuntime.create({
  authPath: join(config.AGENT_DATA_DIR, "pi/auth.json"),
  modelsPath: join(config.AGENT_DATA_DIR, "pi/models.json"),
  allowModelNetwork: false,
});
if (config.AGENT_BASE_URL) {
  models.registerProvider(config.AGENT_PROVIDER, {
    api: "openai-completions",
    baseUrl: config.AGENT_BASE_URL,
    models: [
      {
        id: config.AGENT_MODEL,
        name: config.AGENT_MODEL,
        input: ["text"],
        reasoning: false,
        contextWindow: config.AGENT_CONTEXT_WINDOW,
        maxTokens: config.AGENT_MAX_TOKENS,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}
if (config.AGENT_API_KEY) {
  await models.setRuntimeApiKey(config.AGENT_PROVIDER, config.AGENT_API_KEY);
}
const selectedModel = models.getModel(config.AGENT_PROVIDER, config.AGENT_MODEL);
if (!selectedModel || !models.hasConfiguredAuth(config.AGENT_PROVIDER)) {
  throw new Error("配置的 Pi 模型不可用或缺少 API 凭据，请检查 .env 或 data/pi/models.json");
}
const model = configureModel(selectedModel, {
  contextWindow: config.AGENT_CONTEXT_WINDOW,
  maxTokens: config.AGENT_MAX_TOKENS,
});
const backend = new MoviePilotClient({
  baseUrl: config.MOVIEPILOT_URL,
  accessToken: config.MOVIEPILOT_ACCESS_TOKEN,
  apiKey: config.MOVIEPILOT_API_KEY,
  username: config.MOVIEPILOT_USERNAME,
  password: config.MOVIEPILOT_PASSWORD,
  downloader: config.MOVIEPILOT_DOWNLOADER,
  savePath: config.MOVIEPILOT_SAVE_PATH,
});
const onError = (error: unknown) => console.error(error);
const runtime = await AgentRuntime.create({
  projectDir,
  dataDir: config.AGENT_DATA_DIR,
  model,
  modelRuntime: models,
  backend,
  onError,
});
let feishu: FeishuUi | undefined;
const tracker = new TaskTracker(runtime.store, backend, {
  intervalMs: config.TASK_POLL_SECONDS * 1000,
  moviePilotUtcOffsetMinutes: config.MOVIEPILOT_UTC_OFFSET_MINUTES,
  onTransition: async (task) => {
    await feishu?.notify(task);
  },
  onError,
});
const app = await createApp({
  runtime,
  tracker,
  ownerId: config.AGENT_OWNER_ID,
  authToken: config.WEB_AUTH_TOKEN,
  webDir: resolve(projectDir, "../web/dist"),
  logger: true,
});
let stopping = false;
const parentWatchdog = config.AGENT_PARENT_PID
  ? setInterval(() => {
      if (process.ppid !== config.AGENT_PARENT_PID) {
        void stop().catch(onError);
      }
    }, 5000)
  : undefined;
parentWatchdog?.unref();
async function stop(): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  clearInterval(parentWatchdog);
  feishu?.stopReceiving();
  const httpClosed = app.close();
  await tracker.close();
  // Abort active runs before waiting for UI delivery during disconnect.
  await runtime.close();
  await feishu?.close();
  await httpClosed;
}
process.once("SIGINT", () => {
  void stop().catch(onError);
});
process.once("SIGTERM", () => {
  void stop().catch(onError);
});
try {
  await app.listen({ host: config.HOST, port: config.PORT });
  if (config.FEISHU_ENABLED) {
    const proxy =
      process.env.HTTPS_PROXY ??
      process.env.https_proxy ??
      process.env.HTTP_PROXY ??
      process.env.http_proxy;
    const channel = createLarkChannel({
      appId: config.FEISHU_APP_ID!,
      appSecret: config.FEISHU_APP_SECRET!,
      transport: "websocket",
      includeRawEvent: true,
      agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
      policy: {
        dmMode: "allowlist",
        dmAllowlist: config.feishuOpenIds,
        groupAllowlist: config.feishuGroupIds,
        requireMention: true,
        respondToMentionAll: false,
      },
      safety: {
        chatQueue: { enabled: false },
        batch: { text: { delayMs: 0, longDelayMs: 0, maxMessages: 1 } },
      },
      handshakeTimeoutMs: 20_000,
      source: "moviepilot-pi-agent",
    });
    feishu = new FeishuUi(runtime, channel, {
      ownerId: config.AGENT_OWNER_ID,
      allowedOpenIds: config.feishuOpenIds,
      allowedGroupIds: config.feishuGroupIds,
      onError,
    });
    await feishu.start();
  }
  tracker.start();
} catch (error) {
  await stop();
  throw error;
}
