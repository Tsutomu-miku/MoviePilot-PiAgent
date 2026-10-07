import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { lockSync } from "proper-lockfile";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type {
  AgentInput,
  AgentReply,
  Conversation,
  DisplayMessage,
  Preferences,
  View,
} from "@mp-pi/contracts";
import type { Identity, Media, SearchSnapshot, Task, TransferSnapshot } from "../domain/types.js";
import * as schema from "../db/schema.js";
import { ConflictError, NotFoundError } from "./errors.js";

const ownedConversation = (identity: Identity) =>
  and(
    eq(schema.conversations.userId, identity.userId),
    eq(schema.conversations.id, identity.conversationId),
  );
const ownedState = (identity: Identity) =>
  and(
    eq(schema.states.userId, identity.userId),
    eq(schema.states.conversationId, identity.conversationId),
  );
const requestKey = (input: AgentInput) =>
  and(eq(schema.requests.userId, input.userId), eq(schema.requests.id, input.requestId));
const requestBody = ({ requestId, text, action }: AgentInput) => ({ requestId, text, action });

export class StateStore {
  private readonly native: Database.Database;
  private readonly db: BetterSQLite3Database<typeof schema>;
  private readonly release: () => void;

  constructor(dataDir: string, migrationsDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.release = lockSync(dataDir, { stale: 10_000, retries: 0 });
    let native: Database.Database | undefined;
    try {
      native = new Database(join(dataDir, "agent.sqlite"));
      this.native = native;
      this.native.pragma("journal_mode = WAL");
      this.native.pragma("foreign_keys = ON");
      this.db = drizzle(this.native, { schema });
      migrate(this.db, { migrationsFolder: migrationsDir });
    } catch (error) {
      native?.close();
      this.release();
      throw error;
    }
    this.db
      .update(schema.requests)
      .set({ status: "interrupted" })
      .where(eq(schema.requests.status, "running"))
      .run();
    for (const task of this.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.state, "submitting"))
      .all()) {
      this.saveTask({
        ...task.value,
        payload:
          task.value.payload.kind === "transfer_retry"
            ? {
                ...task.value.payload,
                items: task.value.payload.items.map((item) =>
                  item.state === "submitting"
                    ? { ...item, state: "unknown", message: "服务在整理时中断，请核对 MP" }
                    : item,
                ),
              }
            : task.value.payload,
        state: "unknown",
        message: "服务在提交过程中中断，请核对后端任务。",
        updatedAt: new Date().toISOString(),
      });
    }
  }

  ensureConversation(identity: Identity, title: string, automaticTitle = false): Conversation {
    const now = new Date().toISOString();
    this.db
      .insert(schema.conversations)
      .values({
        userId: identity.userId,
        id: identity.conversationId,
        title: title.slice(0, 60),
        automaticTitle,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
    return this.getConversation(identity);
  }
  getConversation(identity: Identity): Conversation {
    const row = this.db
      .select()
      .from(schema.conversations)
      .where(ownedConversation(identity))
      .get();
    if (!row) {
      throw new NotFoundError("会话不存在");
    }
    return { id: row.id, title: row.title, updatedAt: row.updatedAt };
  }
  listConversations(userId: string): Conversation[] {
    return this.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.userId, userId))
      .orderBy(desc(schema.conversations.updatedAt))
      .all()
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
  }
  getSessionFile(identity: Identity): string | undefined {
    return (
      this.db
        .select({ file: schema.conversations.sessionFile })
        .from(schema.conversations)
        .where(ownedConversation(identity))
        .get()?.file ?? undefined
    );
  }
  setSessionFile(identity: Identity, file: string): void {
    this.db
      .update(schema.conversations)
      .set({ sessionFile: file })
      .where(ownedConversation(identity))
      .run();
  }
  getRequest(input: AgentInput) {
    const row = this.db.select().from(schema.requests).where(requestKey(input)).get();
    if (
      row &&
      (row.conversationId !== input.conversationId ||
        JSON.stringify(row.input) !== JSON.stringify(requestBody(input)))
    ) {
      throw new ConflictError("消息 ID 已用于不同内容");
    }
    return row;
  }
  beginRequest(input: AgentInput): void {
    this.db
      .insert(schema.requests)
      .values({
        userId: input.userId,
        id: input.requestId,
        conversationId: input.conversationId,
        input: requestBody(input),
        status: "running",
      })
      .run();
  }
  finishRequest(input: AgentInput, reply: AgentReply): void {
    this.db.update(schema.requests).set({ status: "done", reply }).where(requestKey(input)).run();
  }
  interruptRequest(input: AgentInput): void {
    this.db.update(schema.requests).set({ status: "interrupted" }).where(requestKey(input)).run();
  }
  addMessage(
    identity: Identity,
    role: DisplayMessage["role"],
    text: string,
    views: View[] = [],
  ): void {
    const now = new Date().toISOString();
    if (role === "user") {
      this.db
        .update(schema.conversations)
        .set({ title: text.slice(0, 60), automaticTitle: false })
        .where(and(ownedConversation(identity), eq(schema.conversations.automaticTitle, true)))
        .run();
    }
    this.db
      .insert(schema.messages)
      .values({ ...identity, id: randomUUID(), role, text, views, createdAt: now })
      .run();
    this.db
      .update(schema.conversations)
      .set({ updatedAt: now })
      .where(ownedConversation(identity))
      .run();
  }
  getMessages(identity: Identity): DisplayMessage[] {
    this.getConversation(identity);
    return this.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.userId, identity.userId),
          eq(schema.messages.conversationId, identity.conversationId),
        ),
      )
      .orderBy(desc(schema.messages.sequence))
      .limit(300)
      .all()
      .reverse()
      .map(({ id, role, text, views, createdAt }) => ({ id, role, text, views, createdAt }));
  }
  getPreferences(userId: string): Preferences {
    return (
      this.db.select().from(schema.preferences).where(eq(schema.preferences.userId, userId)).get()
        ?.value ?? {}
    );
  }
  setPreferences(userId: string, value: Preferences, source: string): void {
    this.db
      .insert(schema.preferences)
      .values({ userId, value, source })
      .onConflictDoUpdate({ target: schema.preferences.userId, set: { value, source } })
      .run();
  }
  getCatalog(identity: Identity): Media[] {
    return this.db.select().from(schema.states).where(ownedState(identity)).get()?.catalog ?? [];
  }
  setCatalog(identity: Identity, catalog: Media[]): void {
    this.db
      .insert(schema.states)
      .values({ ...identity, catalog })
      .onConflictDoUpdate({
        target: [schema.states.userId, schema.states.conversationId],
        set: { catalog, search: null },
      })
      .run();
  }
  getSearch(identity: Identity): SearchSnapshot | undefined {
    return (
      this.db.select().from(schema.states).where(ownedState(identity)).get()?.search ?? undefined
    );
  }
  getTransfers(identity: Identity): TransferSnapshot | undefined {
    return (
      this.db.select().from(schema.states).where(ownedState(identity)).get()?.transfers ?? undefined
    );
  }
  setTransfers(identity: Identity, transfers: TransferSnapshot): void {
    this.db
      .insert(schema.states)
      .values({ ...identity, catalog: [], transfers })
      .onConflictDoUpdate({
        target: [schema.states.userId, schema.states.conversationId],
        set: { transfers },
      })
      .run();
  }
  setSearch(identity: Identity, search: SearchSnapshot | null): void {
    this.db
      .insert(schema.states)
      .values({ ...identity, catalog: [], search })
      .onConflictDoUpdate({
        target: [schema.states.userId, schema.states.conversationId],
        set: { search },
      })
      .run();
  }
  saveTask(task: Task): void {
    this.db
      .insert(schema.tasks)
      .values({
        id: task.id,
        userId: task.userId,
        conversationId: task.conversationId,
        createdAt: task.createdAt,
        state: task.state,
        value: task,
      })
      .onConflictDoUpdate({ target: schema.tasks.id, set: { state: task.state, value: task } })
      .run();
  }
  getTask(userId: string, id: string): Task {
    const row = this.db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.id, id), eq(schema.tasks.userId, userId)))
      .get();
    if (!row) {
      throw new NotFoundError("任务不存在");
    }
    return row.value;
  }
  listTasks(userId: string, conversationId?: string): Task[] {
    const owner = eq(schema.tasks.userId, userId);
    return this.db
      .select()
      .from(schema.tasks)
      .where(conversationId ? and(owner, eq(schema.tasks.conversationId, conversationId)) : owner)
      .orderBy(desc(schema.tasks.createdAt))
      .limit(500)
      .all()
      .map((row) => row.value);
  }
  findDuplicateTask(
    userId: string,
    destination: string,
    key: string,
    hashes: string[],
    sourceKeys: string[] = [],
  ): Task | undefined {
    const matchesHash =
      hashes.length > 0
        ? sql`EXISTS (
          SELECT 1 FROM json_each(${schema.tasks.value}, '$.payload.infoHashes') AS hash
          WHERE hash.value IN (${sql.join(
            hashes.map((hash) => sql`${hash}`),
            sql`, `,
          )})
        )`
        : sql`0`;
    const row = this.db
      .select({ value: schema.tasks.value })
      .from(schema.tasks)
      .where(
        and(
          eq(schema.tasks.userId, userId),
          sql`json_extract(${schema.tasks.value}, '$.destination') = ${destination}`,
          or(
            sql`json_extract(${schema.tasks.value}, '$.submissionKey') = ${key}`,
            matchesHash,
            sourceKeys.length > 0
              ? sql`EXISTS (SELECT 1 FROM json_each(${schema.tasks.value}, '$.payload.items') AS item WHERE json_extract(item.value, '$.state') != 'failed' AND json_extract(item.value, '$.sourceKey') IN (${sql.join(
                  sourceKeys.map((sourceKey) => sql`${sourceKey}`),
                  sql`, `,
                )}))`
              : sql`0`,
          ),
          or(
            inArray(schema.tasks.state, ["awaiting_confirmation", "submitting", "unknown"]),
            and(
              sql`json_extract(${schema.tasks.value}, '$.kind') = 'download'`,
              inArray(schema.tasks.state, ["submitted", "downloading", "downloaded", "imported"]),
            ),
          ),
        ),
      )
      .get();
    return row?.value;
  }
  activeTasks(): Task[] {
    return this.db
      .select()
      .from(schema.tasks)
      .where(inArray(schema.tasks.state, ["submitted", "downloading", "downloaded", "unknown"]))
      .all()
      .map((row) => row.value);
  }
  pendingNotifications(): Task[] {
    return this.db
      .select()
      .from(schema.tasks)
      .where(inArray(schema.tasks.state, ["downloaded", "imported", "failed", "unknown"]))
      .all()
      .map((row) => row.value)
      .filter((task) => task.notifiedState !== task.state);
  }
  claimTask(task: Task): void {
    const value: Task = {
      ...task,
      state: "submitting",
      updatedAt: new Date().toISOString(),
      message: "正在提交",
    };
    const result = this.db
      .update(schema.tasks)
      .set({ state: value.state, value })
      .where(and(eq(schema.tasks.id, task.id), eq(schema.tasks.state, "awaiting_confirmation")))
      .run();
    if (result.changes !== 1) {
      throw new ConflictError("任务已被处理");
    }
  }
  getBinding(userId: string, endpoint: string): string | undefined {
    return this.db
      .select()
      .from(schema.bindings)
      .where(and(eq(schema.bindings.userId, userId), eq(schema.bindings.endpoint, endpoint)))
      .get()?.conversationId;
  }
  setBinding(userId: string, endpoint: string, conversationId: string): void {
    this.db
      .insert(schema.bindings)
      .values({ userId, endpoint, conversationId })
      .onConflictDoUpdate({
        target: [schema.bindings.userId, schema.bindings.endpoint],
        set: { conversationId },
      })
      .run();
  }
  setFeishuRoute(identity: Identity, value: schema.FeishuRoute): void {
    this.db
      .insert(schema.routes)
      .values({ ...identity, value })
      .onConflictDoUpdate({
        target: [schema.routes.userId, schema.routes.conversationId],
        set: { value },
      })
      .run();
  }
  getFeishuRoute(identity: Identity): schema.FeishuRoute | undefined {
    return this.db
      .select()
      .from(schema.routes)
      .where(
        and(
          eq(schema.routes.userId, identity.userId),
          eq(schema.routes.conversationId, identity.conversationId),
        ),
      )
      .get()?.value;
  }
  close(): void {
    this.native.close();
    this.release();
  }
}
