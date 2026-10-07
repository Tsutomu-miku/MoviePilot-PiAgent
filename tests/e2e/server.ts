import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { AgentRuntime } from "../../apps/api/src/core/runtime.js";
import { createApp } from "../../apps/api/src/http/app.js";
import { FakeBackend } from "../../apps/api/tests/fixtures.js";
import Fastify, { type HTTPMethods } from "fastify";

const projectDir = resolve("apps/api");
const dataDir = await mkdtemp(join(tmpdir(), "pi-agent-browser-"));
const faux = fauxProvider({ provider: "browser-test", tokensPerSecond: 10000 });
const models = await ModelRuntime.create({
  authPath: join(dataDir, "auth.json"),
  modelsPath: null,
  refreshOnCreate: false,
});
models.registerNativeProvider(faux.provider);
function respond(context: TranscriptContext) {
  const last = context.messages.at(-1);
  const user = [...context.messages].reverse().find((item) => item.role === "user");
  const text =
    user?.role === "user"
      ? typeof user.content === "string"
        ? user.content
        : user.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("")
      : "";
  if (text === "预览后取消") {
    if (last?.role === "toolResult" && last.toolName === "prepare_links") {
      const content = last.content.find((block) => block.type === "text");
      if (!content || content.type !== "text") {
        throw new Error("Missing preview result");
      }
      const view = JSON.parse(content.text);
      return fauxAssistantMessage(fauxToolCall("cancel_task", { taskId: view.task.id }));
    }
    if (last?.role === "toolResult" && last.toolName === "cancel_task") {
      return fauxAssistantMessage("预览已取消，没有提交下载。");
    }
    return fauxAssistantMessage([
      fauxText("先生成一份预览。"),
      fauxToolCall("prepare_links", { links: `magnet:?xt=urn:btih:${"a".repeat(40)}` }),
    ]);
  }
  if (last?.role === "toolResult") {
    return fauxAssistantMessage("已找到媒体，可以选择资源并继续补充条件。");
  }
  if (/哈姆奈特|Hamnet/i.test(text)) {
    return fauxAssistantMessage(fauxToolCall("search_media", { query: "Hamnet" }));
  }
  if (/订阅/.test(text)) {
    return fauxAssistantMessage(fauxToolCall("list_subscriptions", {}));
  }
  return fauxAssistantMessage("同一会话中已收到补充条件。");
}
faux.setResponses(Array.from({ length: 100 }, () => respond));
const backend = new FakeBackend();
const runtime = await AgentRuntime.create({
  projectDir,
  dataDir,
  model: faux.getModel(),
  modelRuntime: models,
  backend,
  onError: console.error,
});
const app = await createApp({
  runtime,
  ownerId: "owner",
  authToken: "offline-browser-token-with-at-least-32-characters",
  tracker: { refresh: async () => undefined },
  webDir: resolve("apps/web/dist"),
  rateLimitMax: 1000,
});
const hostedPrefix = "/api/v1/plugin/PiAgentBridge/ui/";
const host = Fastify();
host.all<{ Params: { "*": string } }>(`${hostedPrefix}*`, async (request, reply) => {
  if (!request.headers.cookie?.includes("mp-test-admin=1")) {
    return reply.code(401).send({ message: "请先登录 MoviePilot" });
  }
  const response = await app.inject({
    method: request.method as HTTPMethods,
    url: request.url.slice(hostedPrefix.length - 1),
    headers: {
      authorization: "Bearer offline-browser-token-with-at-least-32-characters",
      "content-type": request.headers["content-type"] ?? "application/json",
    },
    payload: request.body,
  });
  const body =
    request.params["*"] === ""
      ? response.body.replace(
          "</head>",
          '<meta name="pi-agent-host" content="moviepilot" /></head>',
        )
      : response.body;
  return reply
    .code(response.statusCode)
    .header("content-type", response.headers["content-type"] ?? "application/json")
    .send(body);
});
await host.listen({ host: "127.0.0.1", port: 8789 });
await app.listen({ host: "127.0.0.1", port: 8788 });
async function shutdown() {
  const closed = Promise.all([app.close(), host.close()]);
  await runtime.close();
  await closed;
  await rm(dataDir, { recursive: true, force: true });
}
process.once("SIGTERM", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
