import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { AgentReply, MessageInput, Preferences, View } from "@mp-pi/contracts";
import type {
  Media,
  SearchSnapshot,
  Task,
  TransferSnapshot,
  MikanSnapshot,
} from "../domain/types.js";

export const conversations = sqliteTable(
  "conversations",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(),
    title: text("title").notNull(),
    automaticTitle: integer("automatic_title", { mode: "boolean" }).notNull().default(false),
    updatedAt: text("updated_at").notNull(),
    sessionFile: text("session_file"),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] })],
);
export const requests = sqliteTable(
  "requests",
  {
    userId: text("user_id").notNull(),
    id: text("id").notNull(),
    conversationId: text("conversation_id").notNull(),
    input: text("input", { mode: "json" }).$type<MessageInput>().notNull(),
    status: text("status", { enum: ["running", "done", "interrupted"] }).notNull(),
    reply: text("reply", { mode: "json" }).$type<AgentReply>(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.id] })],
);
export const messages = sqliteTable("messages", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  id: text("id").notNull(),
  userId: text("user_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  text: text("text").notNull(),
  views: text("views", { mode: "json" }).$type<View[]>().notNull(),
  createdAt: text("created_at").notNull(),
});
export const preferences = sqliteTable("preferences", {
  userId: text("user_id").primaryKey(),
  value: text("value", { mode: "json" }).$type<Preferences>().notNull(),
  source: text("source").notNull(),
});
export const states = sqliteTable(
  "conversation_states",
  {
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    catalog: text("catalog", { mode: "json" }).$type<Media[]>().notNull(),
    search: text("search", { mode: "json" }).$type<SearchSnapshot>(),
    mikanSearch: text("mikan_search", { mode: "json" }).$type<MikanSnapshot>(),
    transfers: text("transfers", { mode: "json" }).$type<TransferSnapshot>(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.conversationId] })],
);
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  conversationId: text("conversation_id").notNull(),
  createdAt: text("created_at").notNull(),
  state: text("state").$type<Task["state"]>().notNull(),
  value: text("value", { mode: "json" }).$type<Task>().notNull(),
});
export const bindings = sqliteTable(
  "ui_bindings",
  {
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    conversationId: text("conversation_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.endpoint] })],
);
export interface FeishuRoute {
  chatId: string;
  senderId: string;
  chatType: "p2p" | "group";
}
export const routes = sqliteTable(
  "feishu_routes",
  {
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    value: text("value", { mode: "json" }).$type<FeishuRoute>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.conversationId] })],
);
