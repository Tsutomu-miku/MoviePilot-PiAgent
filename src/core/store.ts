import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentInput, AgentReply } from "./contracts.js";

export class StateStore {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, "state.sqlite"));
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS conversations (
        user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, session_file TEXT NOT NULL,
        PRIMARY KEY(user_id, conversation_id)
      );
      CREATE TABLE IF NOT EXISTS preferences (
        user_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, source TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY(user_id, name)
      );
      CREATE TABLE IF NOT EXISTS requests (
        user_id TEXT NOT NULL, request_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
        text TEXT NOT NULL, status TEXT NOT NULL, reply TEXT,
        PRIMARY KEY(user_id, request_id)
      );
      UPDATE requests SET status='interrupted' WHERE status='running';
    `);
  }

  getSessionFile(userId: string, conversationId: string): string | undefined {
    const row = this.db.prepare("SELECT session_file FROM conversations WHERE user_id=? AND conversation_id=?")
      .get(userId, conversationId);
    return row?.session_file as string | undefined;
  }

  setSessionFile(userId: string, conversationId: string, path: string): void {
    this.db.prepare("INSERT OR REPLACE INTO conversations VALUES (?,?,?)").run(userId, conversationId, path);
  }

  getRequest(input: AgentInput): { status: string; reply?: AgentReply } | undefined {
    const row = this.db.prepare("SELECT * FROM requests WHERE user_id=? AND request_id=?")
      .get(input.userId, input.requestId);
    if (!row) return undefined;
    if (row.conversation_id !== input.conversationId || row.text !== input.text) {
      throw new Error("Request ID was reused with different content");
    }
    return { status: row.status as string, reply: row.reply ? JSON.parse(row.reply as string) as AgentReply : undefined };
  }

  beginRequest(input: AgentInput): void {
    this.db.prepare("INSERT INTO requests VALUES (?,?,?,?,?,NULL)")
      .run(input.userId, input.requestId, input.conversationId, input.text, "running");
  }

  finishRequest(input: AgentInput, reply: AgentReply): void {
    this.db.prepare("UPDATE requests SET status='done',reply=? WHERE user_id=? AND request_id=?")
      .run(JSON.stringify(reply), input.userId, input.requestId);
  }

  interruptRequest(input: AgentInput): void {
    this.db.prepare("UPDATE requests SET status='interrupted' WHERE user_id=? AND request_id=?")
      .run(input.userId, input.requestId);
  }

  getPreferences(userId: string): Record<string, string> {
    const rows = this.db.prepare("SELECT name,value FROM preferences WHERE user_id=?").all(userId);
    return Object.fromEntries(rows.map(row => [row.name as string, JSON.parse(row.value as string) as string]));
  }

  /** Adapter/application API: future-default consent is required before calling. */
  setPreference(userId: string, name: string, value: string, source: string): void {
    this.db.prepare("INSERT OR REPLACE INTO preferences VALUES (?,?,?,?,?)")
      .run(userId, name, JSON.stringify(value), source, new Date().toISOString());
  }

  close(): void { this.db.close(); }
}
