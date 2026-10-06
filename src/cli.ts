import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { AgentRuntime } from "./core/runtime.js";
import { MoviePilotClient } from "./integrations/moviepilot.js";
import { ConsoleUi } from "./ui/console.js";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dataDir = resolve(process.env.AGENT_DATA_DIR ?? "./data");
const provider = process.env.AGENT_PROVIDER?.trim();
const modelId = process.env.AGENT_MODEL?.trim();
if (!provider || !modelId) throw new Error("Set an explicit AGENT_PROVIDER and AGENT_MODEL first");
const models = await ModelRuntime.create({ authPath: resolve(dataDir, "pi/auth.json"), modelsPath: resolve(dataDir, "pi/models.json") });
const model = models.getModel(provider, modelId);
if (!model) throw new Error("The configured provider/model is not available in Pi");
if (!models.hasConfiguredAuth(provider)) throw new Error("The configured provider has no API credentials");
const backend = process.env.MOVIEPILOT_URL && process.env.MOVIEPILOT_ACCESS_TOKEN
  ? new MoviePilotClient(process.env.MOVIEPILOT_URL, process.env.MOVIEPILOT_ACCESS_TOKEN) : undefined;
const runtime = await AgentRuntime.create({ projectDir, dataDir, model, backend });
const ui = new ConsoleUi();
const reader = createInterface({ input: process.stdin, output: process.stdout });
const conversationId = process.env.AGENT_CONVERSATION_ID ?? "default";
const shutdown = () => { reader.close(); return runtime.close(); };
const onSignal = () => { void shutdown(); };
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
try {
  for await (const text of reader) {
    if (text.trim() === "/exit") break;
    if (!text.trim()) continue;
    try {
      await runtime.handle({ userId: "local", conversationId, requestId: randomUUID(), text }, ui);
      process.stdout.write("\n");
    } catch { process.stderr.write("Request failed; check configuration and retry with a new request.\n"); }
  }
} finally {
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
  await shutdown();
}
