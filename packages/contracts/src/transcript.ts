import type { TranscriptBlock, UiEvent } from "./index.js";

export function applyTranscriptEvent(blocks: TranscriptBlock[], event: UiEvent): TranscriptBlock[] {
  switch (event.type) {
    case "block_start":
      return [...blocks, event.block];
    case "block_delta":
      return blocks.map((block) =>
        block.id === event.id && block.type !== "tool"
          ? { ...block, text: block.text + event.text }
          : block,
      );
    case "tool_start":
      return [
        ...blocks,
        {
          id: event.id,
          type: "tool",
          name: event.name,
          input: event.input,
          output: "",
          state: "running",
        },
      ];
    case "tool_end":
      return blocks.map((block) =>
        block.id === event.id && block.type === "tool"
          ? { ...block, output: event.output, state: event.failed ? "failed" : "completed" }
          : block,
      );
    default:
      return blocks;
  }
}
