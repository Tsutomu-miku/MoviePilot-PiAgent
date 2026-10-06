import { uiEventSchema, type UiEvent } from "./index.js";

export async function* decodeUiStream(body: ReadableStream<Uint8Array>): AsyncGenerator<UiEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let replied = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = frame.split("\n").find((item) => item.startsWith("data: "));
        if (line) {
          const event = uiEventSchema.parse(JSON.parse(line.slice(6)));
          if (event.type === "error") {
            throw new Error(event.message);
          }
          if (event.type === "reply") {
            replied = true;
          }
          yield event;
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!replied) {
    throw new Error("连接在回复完成前断开，请查看会话和任务记录");
  }
}
