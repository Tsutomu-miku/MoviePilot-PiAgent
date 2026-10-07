import { Fragment, useState, useEffect, useRef, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UserAction } from "@mp-pi/contracts";
import { messageId } from "@mp-pi/contracts";
import { ApiClient } from "../api";
import type { PendingReply } from "../hooks/useChat";
import { MessageViews } from "./MessageViews";
import { Dialog } from "./Dialog";
import { MikanSearchForm } from "./MikanSearchForm";
import { AssistantContent } from "./AssistantContent";

interface Props {
  conversationId: string;
  api: ApiClient;
  pending: PendingReply[];
  selectedSkill?: string;
  onClearSkill(): void;
  onSend(text: string, action?: UserAction): void;
}

export function Chat({ conversationId, api, pending, selectedSkill, onClearSkill, onSend }: Props) {
  const messages = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => api.messages(conversationId),
  });
  const [draft, setDraft] = useState("");
  const [linksOpen, setLinksOpen] = useState(false);
  const [mikanOpen, setMikanOpen] = useState(false);
  const [links, setLinks] = useState("");
  const [collapsedThinking, setCollapsedThinking] = useState(() => new Set<string>());
  function onThinkingToggle(id: string, open: boolean) {
    setCollapsedThinking((current) => {
      if (current.has(id) === !open) {
        return current;
      }
      const next = new Set(current);
      if (open) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }
  const tasks = useQuery({ queryKey: ["tasks"], queryFn: () => api.tasks() });
  const bottom = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const active = pending.filter((item) => item.conversationId === conversationId);
  const activeIds = new Set(
    active.flatMap((item) => [item.user.id, messageId(item.id, "assistant")]),
  );
  const history = (messages.data ?? []).filter((item) => !activeIds.has(item.id));
  const busy = active.length > 0;
  const currentMikanSearchId = history
    .flatMap((message) => message.views)
    .filter((view) => view.kind === "mikan")
    .at(-1)?.searchId;
  const currentSearchId = history
    .flatMap((message) => message.views)
    .filter((view) => view.kind === "resources")
    .at(-1)?.searchId;
  const currentTransferSearchId = history
    .flatMap((message) => message.views)
    .filter((view) => view.kind === "transfer_failures")
    .at(-1)?.searchId;
  useEffect(() => {
    if (followOutput.current) {
      bottom.current?.scrollIntoView({ block: "end" });
    }
  }, [messages.data, pending]);
  useEffect(() => {
    followOutput.current = true;
    bottom.current?.scrollIntoView({ block: "end" });
  }, [conversationId]);
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
      <div
        className="chat-history"
        aria-live="polite"
        aria-busy={busy}
        onScroll={(event) => {
          const history = event.currentTarget;
          followOutput.current =
            history.scrollHeight - history.scrollTop - history.clientHeight < 80;
        }}
      >
        {messages.isPending && <p className="muted">正在加载会话…</p>}
        {messages.error && (
          <p role="alert" className="error">
            {messages.error.message}
          </p>
        )}
        {history.length === 0 && !busy && (
          <div className="empty-state">
            <h2>从想看的内容开始</h2>
            <p>可以连续补充名称、清晰度、声道和字幕。下载前会让你确认。</p>
            <div className="button-row">
              <button
                onClick={() => onAction({ type: "transfer_failures", page: 1 }, "查询整理失败记录")}
              >
                整理失败记录
              </button>
              <button onClick={() => onSend("搜索电影哈姆奈特")}>搜索电影</button>
              <button onClick={() => setLinksOpen(true)}>粘贴链接到 115</button>
              <button onClick={() => setMikanOpen(true)}>蜜柑搜索</button>
              <button onClick={() => onSend("查看 MoviePilot 原生订阅")}>查看订阅</button>
            </div>
          </div>
        )}
        {history.map((message) => (
          <article className={`message message-${message.role}`} key={message.id}>
            <div className="message-label">{message.role === "user" ? "你" : "Pi Agent"}</div>
            {message.role === "assistant" ? (
              <AssistantContent
                text={message.text}
                transcript={message.transcript}
                collapsedThinking={collapsedThinking}
                onThinkingToggle={onThinkingToggle}
              />
            ) : (
              <p className="message-text">{message.text}</p>
            )}
            <MessageViews
              views={message.views}
              api={api}
              conversationId={conversationId}
              busy={busy}
              onAction={onAction}
              tasks={tasks.data ?? []}
              currentSearchId={currentSearchId}
              currentTransferSearchId={currentTransferSearchId}
              currentMikanSearchId={currentMikanSearchId}
            />
          </article>
        ))}
        {active.map((item) => (
          <Fragment key={item.id}>
            <article className="message message-user">
              <div className="message-label">你</div>
              <p className="message-text">{item.user.text}</p>
            </article>
            <article className="message message-assistant">
              <div className="message-label">Pi Agent · {item.status}</div>
              <AssistantContent
                text=""
                transcript={item.transcript}
                collapsedThinking={collapsedThinking}
                onThinkingToggle={onThinkingToggle}
              />
            </article>
          </Fragment>
        ))}
        <div ref={bottom} />
      </div>
      <form className="composer" onSubmit={submit}>
        {selectedSkill && (
          <div className="selected-skill">
            <span>技能：{selectedSkill}</span>
            <button type="button" onClick={onClearSkill}>
              取消选择
            </button>
          </div>
        )}
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
          <button type="button" onClick={() => setMikanOpen(true)}>
            蜜柑搜索
          </button>
          <button
            type="button"
            onClick={() => onAction({ type: "transfer_failures", page: 1 }, "查询整理失败记录")}
          >
            整理失败
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
      {mikanOpen && (
        <Dialog title="搜索蜜柑计划" onClose={() => setMikanOpen(false)}>
          <p>直接搜索站点的发布资源，支持中文关键词和字幕组。</p>
          <MikanSearchForm
            disabled={busy}
            onSubmit={(query) => {
              onAction({ type: "mikan_search", query }, `搜索蜜柑：${query.keyword}`);
              setMikanOpen(false);
            }}
          />
        </Dialog>
      )}
    </section>
  );
}
