import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type {
  DisplayMessage,
  TaskSummary,
  TranscriptBlock,
  UserAction,
  View,
} from "@mp-pi/contracts";
import { applyTranscriptEvent, messageId } from "@mp-pi/contracts";
import { v4 as uuid } from "uuid";
import { ApiClient } from "../api";

export interface PendingReply {
  id: string;
  conversationId: string;
  user: DisplayMessage;
  transcript: TranscriptBlock[];
  status: string;
}

export function useChat(api: ApiClient) {
  const client = useQueryClient();
  const [pending, setPending] = useState<PendingReply[]>([]);
  const [error, setError] = useState("");

  async function send(
    conversationId: string,
    text: string,
    action?: UserAction,
    skillName?: string,
  ): Promise<void> {
    const requestId = uuid();
    const placeholder: PendingReply = {
      id: requestId,
      conversationId,
      user: {
        id: messageId(requestId, "user"),
        role: "user",
        text,
        views: [],
        transcript: [],
        createdAt: new Date().toISOString(),
      },
      transcript: [],
      status: "等待处理…",
    };
    setError("");
    setPending((current) => [...current, placeholder]);
    const update = (patch: Partial<PendingReply>) =>
      setPending((current) =>
        current.map((item) => (item.id === requestId ? { ...item, ...patch } : item)),
      );
    let transcript: TranscriptBlock[] = [];
    const finish = async (replyText: string, views: View[], blocks: TranscriptBlock[]) => {
      const assistant: DisplayMessage = {
        id: messageId(requestId, "assistant"),
        role: "assistant",
        text: replyText,
        views,
        transcript: blocks,
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
      for await (const event of api.send(conversationId, { requestId, text, action, skillName })) {
        const next = applyTranscriptEvent(transcript, event);
        if (next !== transcript) {
          transcript = next;
          update({ transcript });
        }
        switch (event.type) {
          case "text_start":
            update({ status: "正在回复…" });
            break;
          case "block_start":
            update({ status: event.block.type === "thinking" ? "正在思考…" : "正在回复…" });
            break;
          case "tool_start":
            update({ status: "正在执行所需操作…" });
            break;
          case "reply":
            await finish(event.reply.text, event.reply.views, event.reply.transcript);
            return;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "请求失败";
      setError(message);
      await finish(
        message,
        [],
        [
          ...transcript.map(
            (block): TranscriptBlock =>
              block.type === "tool" && block.state === "running"
                ? { ...block, state: "failed", output: "执行中断，请核对任务状态。" }
                : block,
          ),
          { id: `${requestId}:error`, type: "text", text: message },
        ],
      );
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
