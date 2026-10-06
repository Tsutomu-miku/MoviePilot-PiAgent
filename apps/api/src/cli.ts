import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  conversationSchema,
  decodeUiStream,
  stateLabels,
  taskSummarySchema,
} from "@mp-pi/contracts";

const token = z.string().min(32).parse(process.env.WEB_AUTH_TOKEN);
const baseUrl = new URL(process.env.AGENT_URL ?? "http://127.0.0.1:8787");
async function request(path: string, method = "GET", body?: unknown): Promise<Response> {
  const response = await fetch(new URL(`/api${path}`, baseUrl), {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = z.object({ message: z.string() }).parse(await response.json());
    throw new Error(error.message);
  }
  return response;
}
async function newConversation(): Promise<string> {
  const response = await request("/conversations", "POST", {});
  return conversationSchema.parse(await response.json()).id;
}
let conversationId = process.env.AGENT_CONVERSATION_ID
  ? z.string().uuid().parse(process.env.AGENT_CONVERSATION_ID)
  : await newConversation();
const reader = createInterface({ input: process.stdin, output: process.stdout });
process.stdout.write(
  `会话 ${conversationId}\n/new 新建 · /sessions 列表 · /use <ID> 切换 · /tasks 任务 · /exit 退出\n`,
);
try {
  for await (const line of reader) {
    const text = line.trim();
    if (text === "/exit") {
      break;
    }
    if (!text) {
      continue;
    }
    try {
      if (text === "/new") {
        conversationId = await newConversation();
        process.stdout.write(`新会话 ${conversationId}\n`);
        continue;
      }
      if (text.startsWith("/use ")) {
        const id = z.string().uuid().parse(text.slice(5));
        await request(`/conversations/${id}/messages`);
        conversationId = id;
        process.stdout.write(`已切换 ${conversationId}\n`);
        continue;
      }
      if (text === "/sessions") {
        const response = await request("/conversations");
        const items = z.array(conversationSchema).parse(await response.json());
        process.stdout.write(items.map((item) => `${item.id}  ${item.title}`).join("\n") + "\n");
        continue;
      }
      if (text === "/tasks") {
        const response = await request(`/tasks?conversationId=${conversationId}`);
        const items = z.array(taskSummarySchema).parse(await response.json());
        process.stdout.write(
          items
            .map((item) => `${stateLabels[item.state]}  ${item.title}  ${item.message}`)
            .join("\n") + "\n",
        );
        continue;
      }
      const response = await request(`/conversations/${conversationId}/messages`, "POST", {
        requestId: randomUUID(),
        text,
      });
      if (!response.body) {
        throw new Error("响应没有流式消息体");
      }
      let streamed = false;
      for await (const event of decodeUiStream(response.body)) {
        if (event.type === "text_delta") {
          streamed = true;
          process.stdout.write(event.text);
        } else if (event.type === "tool_start") {
          process.stdout.write(`\n[${event.name}]\n`);
        } else if (event.type === "view") {
          process.stdout.write(`\n${JSON.stringify(event.view, null, 2)}\n`);
        } else if (event.type === "reply" && !streamed) {
          process.stdout.write(event.reply.text);
        }
      }
      process.stdout.write("\n");
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : "请求失败"}\n`);
    }
  }
} finally {
  reader.close();
}
