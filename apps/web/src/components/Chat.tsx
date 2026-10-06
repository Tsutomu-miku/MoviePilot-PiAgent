import { useState, useEffect, useRef, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UserAction } from "@mp-pi/contracts";
import { ApiClient } from "../api";
import type { PendingReply } from "../hooks/useChat";
import { MessageViews } from "./MessageViews";
import { Dialog } from "./Dialog";

interface Props {
  conversationId: string;
  api: ApiClient;
  pending: PendingReply[];
  onSend(text: string, action?: UserAction): void;
}

export function Chat({ conversationId, api, pending, onSend }: Props) {
  const messages = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => api.messages(conversationId),
  });
  const [draft, setDraft] = useState("");
  const [linksOpen, setLinksOpen] = useState(false);
  const [links, setLinks] = useState("");
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const bottom = useRef<HTMLDivElement>(null);
  const active = pending.filter((item) => item.conversationId === conversationId);
  const busy = active.length > 0;
  const currentSearchId = [
    ...(messages.data ?? []).flatMap((message) => message.views),
    ...active.flatMap((item) => item.views),
  ]
    .filter((view) => view.kind === "resources")
    .at(-1)?.searchId;
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.data, active.length]);
  const onAction = (action: UserAction, label: string) => onSend(label, action);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft.trim()) {
      onSend(draft.trim());
      setDraft("");
    }
  }
  function submitLinks(event: FormEvent) {
    event.preventDefault();
    if (links.trim()) {
      onAction({ type: "prepare_links", links: links.trim() }, "预览链接并推送到 115");
      setLinksOpen(false);
      setLinks("");
    }
  }
  return (
    <section className="chat-panel" aria-label="Agent 对话">
      <div className="chat-history" aria-live="polite" aria-busy={busy}>
        {messages.isPending && <p className="muted">正在加载会话…</p>}
        {messages.error && (
          <p role="alert" className="error">
            {messages.error.message}
          </p>
        )}
        {messages.data?.length === 0 && (
          <div className="empty-state">
            <h2>从想看的内容开始</h2>
            <p>可以连续补充名称、清晰度、声道和字幕。下载前会让你确认。</p>
            <div className="button-row">
              <button onClick={() => onSend("搜索电影哈姆奈特")}>搜索电影</button>
              <button onClick={() => setLinksOpen(true)}>粘贴链接到 115</button>
              <button onClick={() => onSend("查看 MoviePilot 原生订阅")}>查看订阅</button>
            </div>
          </div>
        )}
        {messages.data?.map((message) => (
          <article className={`message message-${message.role}`} key={message.id}>
            <div className="message-label">{message.role === "user" ? "你" : "Pi Agent"}</div>
            <p className="message-text">{message.text}</p>
            <MessageViews
              views={message.views}
              api={api}
              conversationId={conversationId}
              busy={busy}
              onAction={onAction}
              tasks={tasks.data ?? []}
              currentSearchId={currentSearchId}
            />
          </article>
        ))}
        {active.map((item) => (
          <article className="message message-assistant" key={item.id}>
            <div className="message-label">Pi Agent · {item.status}</div>
            <p className="message-text">{item.text}</p>
            <MessageViews
              views={item.views}
              api={api}
              conversationId={conversationId}
              busy={true}
              onAction={onAction}
              tasks={tasks.data ?? []}
              currentSearchId={currentSearchId}
            />
          </article>
        ))}
        <div ref={bottom} />
      </div>
      <form className="composer" onSubmit={submit}>
        <textarea
          aria-label="消息"
          placeholder="想看什么？也可以继续补充条件…"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={2}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className="composer-actions">
          <button type="button" onClick={() => setLinksOpen(true)}>
            粘贴链接到 115
          </button>
          <span className="muted">Enter 发送 · Shift+Enter 换行</span>
          <button className="primary" disabled={!draft.trim()} type="submit">
            发送
          </button>
        </div>
      </form>
      {linksOpen && (
        <Dialog title="推送链接到 115" onClose={() => setLinksOpen(false)}>
          <p>粘贴磁力链接或公开种子下载链接，每行一个。保存到插件现有目录。</p>
          <form onSubmit={submitLinks}>
            <textarea
              autoFocus
              aria-label="种子链接"
              rows={7}
              value={links}
              onChange={(event) => setLinks(event.target.value)}
              placeholder="magnet:?xt=urn:btih:…"
            />
            <div className="button-row">
              <button type="submit" className="primary" disabled={!links.trim() || busy}>
                预览
              </button>
              <button type="button" onClick={() => setLinksOpen(false)}>
                关闭
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
