import { z } from "zod";
import {
  conversationSchema,
  displayMessageSchema,
  preferencesSchema,
  taskSummarySchema,
  decodeUiStream,
  viewSchema,
  type MessageInput,
  type Preferences,
  type UiEvent,
} from "@mp-pi/contracts";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class ApiClient {
  constructor(private readonly token: string) {}

  private async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(`/api${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
    });
    if (!response.ok) {
      const body = z.object({ message: z.string() }).parse(await response.json());
      throw new HttpError(body.message, response.status);
    }
    return response;
  }

  private async request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const response = await this.fetch(path, init);
    return schema.parse(await response.json());
  }

  conversations() {
    return this.request("/conversations", z.array(conversationSchema));
  }

  createConversation() {
    return this.request("/conversations", conversationSchema, {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  messages(conversationId: string) {
    return this.request(`/conversations/${conversationId}/messages`, z.array(displayMessageSchema));
  }

  tasks() {
    return this.request("/tasks", z.array(taskSummarySchema));
  }

  refreshTasks() {
    return this.request("/tasks/refresh", z.array(taskSummarySchema), { method: "POST" });
  }

  preferences() {
    return this.request("/preferences", preferencesSchema);
  }

  savePreferences(value: Preferences) {
    return this.request("/preferences", preferencesSchema, {
      method: "PUT",
      body: JSON.stringify(value),
    });
  }

  resources(conversationId: string, searchId: string, offset: number) {
    return this.request(
      `/conversations/${conversationId}/resources?${new URLSearchParams({ searchId, offset: String(offset) })}`,
      viewSchema,
    );
  }

  async *send(conversationId: string, input: MessageInput): AsyncGenerator<UiEvent> {
    const response = await this.fetch(`/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.body) {
      throw new Error("浏览器不支持流式响应");
    }
    yield* decodeUiStream(response.body);
  }
}
