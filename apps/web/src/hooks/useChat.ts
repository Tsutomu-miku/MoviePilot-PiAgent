import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DisplayMessage, UserAction, View } from "@mp-pi/contracts";
import { ApiClient } from "../api";

export interface PendingReply {
  id: string;
  conversationId: string;
  text: string;
  views: View[];
  status: string;
}

export function useChat(api: ApiClient) {
  const client = useQueryClient();
  const [pending, setPending] = useState<PendingReply[]>([]);
  const [error, setError] = useState("");

  async function send(conversationId: string, text: string, action?: UserAction): Promise<void> {
    const requestId = crypto.randomUUID();
    const placeholder: PendingReply = {
      id: requestId,
      conversationId,
      text: "",
      views: [],
      status: "等待处理…",
    };
    setError("");
    setPending((current) => [...current, placeholder]);
    client.setQueryData<DisplayMessage[]>(["messages", conversationId], (current) => [
      ...(current ?? []),
      {
        id: requestId,
        role: "user",
        text,
        views: [],
        createdAt: new Date().toISOString(),
      },
    ]);
    const update = (patch: Partial<PendingReply>) =>
      setPending((current) =>
        current.map((item) => (item.id === requestId ? { ...item, ...patch } : item)),
      );
    try {
      for await (const event of api.send(conversationId, { requestId, text, action })) {
        switch (event.type) {
          case "text_start":
            update({ text: "", status: "正在回复…" });
            break;
          case "text_delta":
            setPending((current) =>
              current.map((item) =>
                item.id === requestId
                  ? { ...item, text: item.text + event.text, status: "正在回复…" }
                  : item,
              ),
            );
            break;
          case "tool_start":
            update({ status: "正在执行所需操作…" });
            break;
          case "view":
            setPending((current) =>
              current.map((item) =>
                item.id === requestId ? { ...item, views: [...item.views, event.view] } : item,
              ),
            );
            break;
          case "reply":
            update({ text: event.reply.text, views: event.reply.views, status: "已完成" });
            break;
        }
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "请求失败");
    } finally {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["messages", conversationId] }),
        client.invalidateQueries({ queryKey: ["conversations"] }),
        client.invalidateQueries({ queryKey: ["tasks"] }),
        client.invalidateQueries({ queryKey: ["preferences"] }),
      ]);
      setPending((current) => current.filter((item) => item.id !== requestId));
    }
  }
  return { pending, error, send };
}
