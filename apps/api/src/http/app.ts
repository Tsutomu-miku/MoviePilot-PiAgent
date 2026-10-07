import { timingSafeEqual, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import rateLimit from "@fastify/rate-limit";
import { z, ZodError } from "zod";
import {
  messageInputSchema,
  preferencesSchema,
  skillNameSchema,
  skillWriteSchema,
} from "@mp-pi/contracts";
import type { AgentRuntime } from "../core/runtime.js";
import { AppError } from "../core/errors.js";
import { publicTask } from "../domain/types.js";
import type { TaskTracker } from "../services/task-tracker.js";

export interface AppOptions {
  runtime: AgentRuntime;
  tracker: Pick<TaskTracker, "refresh">;
  ownerId: string;
  authToken: string;
  webDir?: string;
  logger?: boolean;
  rateLimitMax?: number;
}
const conversationParams = z.object({ id: z.string().uuid() });
const taskQuery = z.object({ conversationId: z.string().uuid().optional() });
const skillParams = z.object({ name: skillNameSchema });

export async function createApp(options: AppOptions) {
  const app = Fastify({
    bodyLimit: 128 * 1024,
    logger: options.logger
      ? { redact: ["req.headers.authorization", "req.headers.cookie"] }
      : false,
  });
  await app.register(rateLimit, {
    max: options.rateLimitMax ?? 120,
    timeWindow: "1 minute",
    errorResponseBuilder: (_request, context) =>
      new AppError("RATE_LIMITED", "请求过于频繁，请稍后再试", context.statusCode),
  });
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/api/") || path === "/api/health") {
      return;
    }
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${options.authToken}`);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      await reply.code(401).send({ message: "请先登录" });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        message: "请求参数不符合 API 约定",
        fields: error.issues.map((issue) => issue.path.join(".")),
      });
    }
    if (error instanceof AppError) {
      return reply.code(error.status).send({ message: error.message, code: error.code });
    }
    request.log.error({ err: error }, "Request failed");
    return reply.code(500).send({ message: "服务处理失败，请检查日志" });
  });
  const identity = (id: string) => ({ userId: options.ownerId, conversationId: id });

  app.get("/api/health", async () => ({ status: "ok", version: "1.3.1" }));
  app.get("/api/skills", async () => options.runtime.skills.list(options.ownerId));
  app.get("/api/skills/:name", async (request) => {
    const { name } = skillParams.parse(request.params);
    return options.runtime.skills.get(options.ownerId, name);
  });
  app.put("/api/skills/:name", async (request) => {
    const { name } = skillParams.parse(request.params);
    return options.runtime.skills.save(options.ownerId, name, skillWriteSchema.parse(request.body));
  });
  app.put("/api/skills/:name/activation", async (request) => {
    const { name } = skillParams.parse(request.params);
    const { enabled } = z.strictObject({ enabled: z.boolean() }).parse(request.body);
    return options.runtime.skills.setEnabled(options.ownerId, name, enabled);
  });
  app.get("/api/conversations", async () =>
    options.runtime.store.listConversations(options.ownerId),
  );
  app.post("/api/conversations", async (request) => {
    const body = z
      .strictObject({ title: z.string().trim().min(1).max(60).optional() })
      .parse(request.body);
    return options.runtime.store.ensureConversation(
      identity(randomUUID()),
      body.title ?? "新会话",
      body.title === undefined,
    );
  });
  app.get("/api/conversations/:id/messages", async (request) => {
    const { id } = conversationParams.parse(request.params);
    return options.runtime.store.getMessages(identity(id));
  });
  app.post("/api/conversations/:id/messages", async (request, reply) => {
    const { id } = conversationParams.parse(request.params);
    options.runtime.store.getConversation(identity(id));
    const body = messageInputSchema.parse(request.body);
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    const publish = (event: unknown) => {
      if (!reply.raw.destroyed) {
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) {
        reply.raw.write(": heartbeat\n\n");
      }
    }, 15_000);
    try {
      await options.runtime.handle(
        { ...identity(id), ...body },
        { publish: (_input, event) => publish(event) },
      );
    } catch (error) {
      request.log.error({ err: error }, "Agent request failed");
      publish({
        type: "error",
        message:
          error instanceof AppError ? error.message : "Agent 请求未完成，请查看任务状态和日志",
      });
    } finally {
      clearInterval(heartbeat);
      reply.raw.end();
    }
  });
  app.get("/api/tasks", async (request) => {
    const query = taskQuery.parse(request.query);
    if (query.conversationId) {
      options.runtime.store.getConversation(identity(query.conversationId));
    }
    return options.runtime.store.listTasks(options.ownerId, query.conversationId).map(publicTask);
  });
  app.post("/api/tasks/refresh", async () => {
    await options.tracker.refresh();
    return options.runtime.store.listTasks(options.ownerId).map(publicTask);
  });
  app.get("/api/preferences", async () => options.runtime.store.getPreferences(options.ownerId));
  app.put("/api/preferences", async (request) => {
    const preferences = preferencesSchema.parse(request.body);
    options.runtime.store.setPreferences(options.ownerId, preferences, "网页偏好表单");
    return preferences;
  });
  app.get("/api/conversations/:id/resources", async (request) => {
    const { id } = conversationParams.parse(request.params);
    options.runtime.store.getConversation(identity(id));
    const query = z
      .object({ searchId: z.string().uuid(), offset: z.coerce.number().int().nonnegative() })
      .parse(request.query);
    return options.runtime.search.listResources(identity(id), query.searchId, query.offset);
  });
  app.get("/api/conversations/:id/mikan-resources", async (request) => {
    const { id } = conversationParams.parse(request.params);
    options.runtime.store.getConversation(identity(id));
    const query = z
      .strictObject({ searchId: z.string().uuid(), offset: z.coerce.number().int().nonnegative() })
      .parse(request.query);
    return options.runtime.mikan.listResources(identity(id), query.searchId, query.offset);
  });
  if (options.webDir && existsSync(join(options.webDir, "index.html"))) {
    await app.register(fastifyStatic, { root: options.webDir });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ message: "API 不存在" });
      }
      return reply.sendFile("index.html");
    });
  }
  return app;
}
