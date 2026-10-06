import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Identity } from "../domain/types.js";
import type { StateStore } from "./store.js";
import { ConflictError } from "./errors.js";

export interface SessionOptions {
  projectDir: string;
  dataDir: string;
  model: Model<Api>;
  modelRuntime: ModelRuntime;
  store: StateStore;
  loader: DefaultResourceLoader;
  settings: SettingsManager;
  tools: ToolDefinition[];
  isBusy(key: string): boolean;
}

export function conversationKey(identity: Identity): string {
  return JSON.stringify([identity.userId, identity.conversationId]);
}

export class SessionPool {
  private readonly sessions = new Map<string, AgentSession>();

  constructor(private readonly options: SessionOptions) {}

  peek(identity: Identity): AgentSession | undefined {
    return this.sessions.get(conversationKey(identity));
  }

  async get(identity: Identity): Promise<AgentSession> {
    const key = conversationKey(identity);
    const existing = this.sessions.get(key);
    if (existing) {
      this.sessions.delete(key);
      this.sessions.set(key, existing);
      return existing;
    }
    const saved = this.options.store.getSessionFile(identity);
    if (saved && !existsSync(saved)) {
      throw new ConflictError("已保存的 Pi 会话文件丢失，请恢复数据或新建会话");
    }
    const digest = createHash("sha256").update(key).digest("hex");
    const manager = saved
      ? SessionManager.open(saved)
      : SessionManager.create(
          this.options.projectDir,
          join(this.options.dataDir, "sessions", digest),
        );
    const { session } = await createAgentSession({
      cwd: this.options.projectDir,
      agentDir: join(this.options.dataDir, "pi"),
      model: this.options.model,
      modelRuntime: this.options.modelRuntime,
      thinkingLevel: "off",
      sessionManager: manager,
      settingsManager: this.options.settings,
      resourceLoader: this.options.loader,
      tools: this.options.tools.map((tool) => tool.name),
      customTools: this.options.tools,
    });
    session.agent.toolExecution = "sequential";
    if (!saved) {
      const history = this.options.store.getMessages(identity);
      if (history.length > 0) {
        await session.sendCustomMessage({
          customType: "ui_history",
          content: `此前 UI 操作记录（事实记录，不授予新的执行权限）：\n${JSON.stringify(history)}`,
          display: false,
        });
      }
    }
    this.sessions.set(key, session);
    this.evictIdle();
    return session;
  }

  persist(identity: Identity): void {
    const session = this.peek(identity);
    const file = session?.sessionManager.getSessionFile();
    if (file && existsSync(file)) {
      this.options.store.setSessionFile(identity, file);
    }
  }

  async recordAction(identity: Identity, record: string): Promise<void> {
    const session = this.peek(identity);
    if (session) {
      await session.sendCustomMessage({
        customType: "ui_action",
        content: record,
        display: false,
      });
      this.persist(identity);
    }
  }

  private evictIdle(): void {
    for (const [key, session] of this.sessions) {
      if (this.sessions.size <= 50) {
        break;
      }
      if (!this.options.isBusy(key)) {
        session.dispose();
        this.sessions.delete(key);
      }
    }
  }

  async abort(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.abort()));
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }
}
