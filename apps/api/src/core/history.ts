import { SessionManager, type SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { DisplayMessage, TranscriptBlock } from "@mp-pi/contracts";
import type { Identity } from "../domain/types.js";
import type { StateStore } from "./store.js";

function turnTranscript(entries: SessionMessageEntry[]): TranscriptBlock[] {
  let blocks: TranscriptBlock[] = [];
  for (const entry of entries) {
    const message = entry.message;
    if (message.role === "assistant") {
      message.content.forEach((content, index) => {
        if (content.type === "text") {
          blocks.push({ id: `${entry.id}:${index}`, type: "text", text: content.text });
        } else if (content.type === "thinking") {
          blocks.push({ id: `${entry.id}:${index}`, type: "thinking", text: content.thinking });
        } else if (content.type === "toolCall") {
          blocks.push({
            id: content.id,
            type: "tool",
            name: content.name,
            input: JSON.stringify(content.arguments, null, 2),
            output: "",
            state: "failed",
          });
        }
      });
    } else if (message.role === "toolResult") {
      blocks = blocks.map((block) =>
        block.type === "tool" && block.id === message.toolCallId
          ? {
              ...block,
              state: message.isError ? "failed" : "completed",
              output: message.content
                .filter((content) => content.type === "text")
                .map((content) => content.text)
                .join("\n"),
            }
          : block,
      );
    }
  }
  return blocks;
}

export function conversationHistory(store: StateStore, identity: Identity): DisplayMessage[] {
  const messages = store.getMessages(identity);
  const file = store.getSessionFile(identity);
  if (
    !file ||
    !messages.some((message) => message.role === "assistant" && message.transcript.length === 0)
  ) {
    return messages;
  }
  const entries = SessionManager.open(file)
    .getBranch()
    .filter((entry): entry is SessionMessageEntry => entry.type === "message");
  const users = new Map(
    messages.filter((message) => message.role === "user").map((message) => [message.id, message]),
  );
  return messages.map((message) => {
    if (message.role !== "assistant" || message.transcript.length > 0) {
      return message;
    }
    const user = users.get(`${message.id.slice(0, -":assistant".length)}:user`);
    if (!user) {
      return message;
    }
    // A saved UI turn brackets the SDK entries; text matching would confuse repeated prompts.
    const starts = entries
      .map((entry, index) => ({ entry, index }))
      .filter(
        ({ entry }) =>
          entry.message.role === "user" &&
          entry.timestamp >= user.createdAt &&
          entry.timestamp <= message.createdAt,
      );
    if (starts.length !== 1) {
      return message;
    }
    const start = starts[0]!.index;
    const nextUser = entries.findIndex(
      (entry, index) => index > start && entry.message.role === "user",
    );
    const turn = entries
      .slice(start, nextUser === -1 ? undefined : nextUser)
      .filter((entry) => entry.timestamp <= message.createdAt);
    const transcript = turnTranscript(turn);
    const final = [...turn].reverse().find((entry) => entry.message.role === "assistant")?.message;
    const finalText =
      final?.role === "assistant"
        ? final.content
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("")
            .trim()
        : "";
    if (transcript.length > 0 && finalText !== message.text) {
      transcript.push({ id: `${message.id}:final`, type: "text", text: message.text });
    }
    return { ...message, transcript };
  });
}
