import { useState } from "react";
import type { UserAction, View, TaskSummary } from "@mp-pi/contracts";
import { ApiClient } from "../api";
import { ResourceView } from "./ResourceView";
import { TaskList } from "./TaskList";
import { TransferView } from "./TransferView";

interface Props {
  views: View[];
  conversationId: string;
  api: ApiClient;
  busy: boolean;
  tasks: TaskSummary[];
  currentSearchId?: string;
  currentTransferSearchId?: string;
  onAction(action: UserAction, label: string): void;
}

export function MessageViews({
  views,
  conversationId,
  api,
  busy,
  onAction,
  tasks,
  currentSearchId,
  currentTransferSearchId,
}: Props) {
  const [season, setSeason] = useState("1");
  return (
    <div className="message-views">
      {views.map((view, index) => {
        switch (view.kind) {
          case "transfer_failures":
            return (
              <TransferView
                key={view.searchId}
                view={view}
                busy={busy}
                current={view.searchId === currentTransferSearchId}
                onAction={onAction}
              />
            );
          case "media":
            return (
              <section key={index} className="media-grid" aria-label="媒体搜索结果">
                {view.items.length === 0 && <p>没有找到媒体，请尝试原名或年份。</p>}
                {view.items.map((media) => (
                  <article className="media-card" key={media.key}>
                    <h3>
                      {media.title} <small>{media.year}</small>
                    </h3>
                    <p className="muted">
                      {media.type} · {media.source}
                    </p>
                    <p>{media.overview}</p>
                    {media.type === "电视剧" && (
                      <label>
                        季号
                        <input
                          type="number"
                          value={season}
                          min="1"
                          max="100"
                          onChange={(event) => setSeason(event.target.value)}
                        />
                      </label>
                    )}
                    <div className="button-row">
                      <button
                        disabled={busy}
                        onClick={() =>
                          onAction(
                            {
                              type: "resources",
                              mediaKey: media.key,
                              criteria: media.type === "电视剧" ? { season: Number(season) } : {},
                            },
                            `搜索 ${media.title} 的资源`,
                          )
                        }
                      >
                        搜索资源
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          onAction(
                            {
                              type: "subscribe",
                              mediaKey: media.key,
                              season: media.type === "电视剧" ? Number(season) : undefined,
                            },
                            `订阅 ${media.title}`,
                          )
                        }
                      >
                        订阅
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            );
          case "resources":
            return (
              <ResourceView
                key={view.searchId}
                view={view}
                api={api}
                conversationId={conversationId}
                onAction={onAction}
                busy={busy}
                current={view.searchId === currentSearchId}
              />
            );
          case "confirmation":
            return (
              <TaskList
                key={index}
                items={[tasks.find((task) => task.id === view.task.id) ?? view.task]}
                busy={busy}
                onAction={onAction}
              />
            );
          case "tasks":
            return (
              <TaskList
                key={index}
                items={view.items.map((item) => tasks.find((task) => task.id === item.id) ?? item)}
                busy={busy}
                onAction={onAction}
              />
            );
          case "library":
            return (
              <article key={index} className="media-card">
                <strong>
                  {view.title} · {view.exists ? "已入库" : "未入库"}
                </strong>
                {view.playUrl && (
                  <p>
                    <a href={view.playUrl} target="_blank" rel="noreferrer">
                      打开媒体库 ↗
                    </a>
                  </p>
                )}
              </article>
            );
          case "subscriptions":
            return (
              <section key={index}>
                {view.items.map((item) => (
                  <article key={item.id} className="media-card">
                    <strong>{item.title}</strong>
                    <p>
                      {item.season ? `第 ${item.season} 季 · ` : ""}
                      {item.state}
                    </p>
                    <div className="button-row">
                      <button
                        disabled={busy}
                        onClick={() =>
                          onAction(
                            {
                              type: "subscription_change",
                              subscriptionId: item.id,
                              operation: item.state === "P" ? "resume" : "pause",
                            },
                            `调整订阅 ${item.title}`,
                          )
                        }
                      >
                        {item.state === "P" ? "恢复" : "暂停"}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          onAction(
                            {
                              type: "subscription_change",
                              subscriptionId: item.id,
                              operation: "delete",
                            },
                            `删除订阅 ${item.title}`,
                          )
                        }
                      >
                        删除
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            );
        }
      })}
    </div>
  );
}
