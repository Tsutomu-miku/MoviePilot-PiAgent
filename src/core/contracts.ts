export interface AgentInput {
  /** Supplied by an authenticated UI adapter, never by model output. */
  userId: string;
  conversationId: string;
  /** Stable platform event ID, reused when delivery is retried. */
  requestId: string;
  text: string;
}

export interface AgentReply {
  conversationId: string;
  requestId: string;
  text: string;
}

export type UiEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; name: string }
  | { type: "tool_end"; name: string; failed: boolean };

export interface UiAdapter {
  publish(input: AgentInput, event: UiEvent): void;
}

export function validateInput(input: AgentInput): void {
  for (const key of ["userId", "conversationId", "requestId"] as const) {
    if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > 200) {
      throw new Error(`Invalid ${key}`);
    }
  }
  if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 32_000) {
    throw new Error("Text must contain 1–32000 characters");
  }
}
