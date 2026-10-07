import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DisplayMessage, TaskSummary, UserAction, View } from "@mp-pi/contracts";
import { messageId } from "@mp-pi/contracts";
import { v4 as uuid } from "uuid";
import { ApiClient } from "../api";

export interface PendingReply {
  id: string;
  conversationId: string;
  user: DisplayMessage;
  text: string;
  status: string;
}

export function useChat(api: ApiClient) {
  const client = useQueryClient();
  const [pending, setPending] = useState<PendingReply[]>([]);
  const [error, setError] = useState("");

  async function send(conversationId: string, text: string, action?: UserAction): Promise<void> {
    const requestId = uuid();
    const placeholder: PendingReply = {
      id: requestId,
      conversationId,
      user: {
        id: messageId(requestId, "user"),
        role: "user",
        text,
        views: [],
        createdAt: new Date().toISOString(),
      },
      text: "",
      status: "等待处理…",
    };
    setError("");
    setPending((current) => [...current, placeholder]);
    const update = (patch: Partial<PendingReply>) =>
      setPending((current) =>
        current.map((item) => (item.id === requestId ? { ...item, ...patch } : item)),
      );
    const finish = async (replyText: string, views: View[]) => {
      const assistant: DisplayMessage = {
        id: messageId(requestId, "assistant"),
        role: "assistant",
        text: replyText,
        views,
        createdAt: new Date().toISOString(),
      };
      await client.cancelQueries({ queryKey: ["messages", conversationId] });
      await client.cancelQueries({ queryKey: ["tasks"] });
      client.setQueryData<TaskSummary[]>(["tasks"], (current) => {
        const tasks = new Map((current ?? []).map((task) => [task.id, task]));
        for (const view of views) {
          const items =
            view.kind === "confirmation" ? [view.task] : view.kind === "tasks" ? view.items : [];
          for (const task of items) {
            const saved = tasks.get(task.id);
            if (!saved || saved.updatedAt <= task.updatedAt) {
              tasks.set(task.id, task);
            }
          }
        }
        return [...tasks.values()];
      });
      client.setQueryData<DisplayMessage[]>(["messages", conversationId], (current) => [
        ...(current ?? []).filter(
          (item) => item.id !== placeholder.user.id && item.id !== assistant.id,
        ),
        placeholder.user,
        assistant,
      ]);
      setPending((current) => current.filter((item) => item.id !== requestId));
    };
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
          case "reply":
            await finish(event.reply.text, event.reply.views);
            return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败";
      setError(message);
      await finish(message, []);
    } finally {
      await Promise.all([
        client.invalidateQueries({ queryKey: ["messages", conversationId] }),
        client.invalidateQueries({ queryKey: ["conversations"] }),
        client.invalidateQueries({ queryKey: ["tasks"] }),
        client.invalidateQueries({ queryKey: ["preferences"] }),
      ]);
    }
  }
  return { pending, error, send };
}
