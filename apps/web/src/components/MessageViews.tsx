import { useState } from "react";
import type { UserAction, View, TaskSummary } from "@mp-pi/contracts";
import { ApiClient } from "../api";
import { ResourceView } from "./ResourceView";
import { TaskList } from "./TaskList";
import { TransferView } from "./TransferView";
import { MikanView } from "./MikanView";
import { ResultCard } from "./ResultCard";

interface Props {
  views: View[];
  conversationId: string;
  api: ApiClient;
  busy: boolean;
  tasks: TaskSummary[];
  currentSearchId?: string;
  currentTransferSearchId?: string;
  currentMikanSearchId?: string;
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
  currentMikanSearchId,
}: Props) {
  const [season, setSeason] = useState("1");
  function currentTask(task: TaskSummary): TaskSummary {
    const current = tasks.find((item) => item.id === task.id);
    return current && current.updatedAt >= task.updatedAt ? current : task;
  }
  return (
    <div className="message-views">
      {views.map((view, index) => {
        switch (view.kind) {
          case "mikan":
            return (
              <ResultCard
                key={view.searchId}
                title="蜜柑搜索结果"
                summary={`${view.query.keyword} · ${view.total} 条资源`}
              >
                <MikanView
                  view={view}
                  api={api}
                  conversationId={conversationId}
                  busy={busy}
                  current={view.searchId === currentMikanSearchId}
                  onAction={onAction}
                />
              </ResultCard>
            );
          case "transfer_failures":
            return (
              <ResultCard
                key={view.searchId}
                title="整理失败记录"
                summary={`共 ${view.total} 条 · 第 ${view.page} 页`}
              >
                <TransferView
                  view={view}
                  busy={busy}
                  current={view.searchId === currentTransferSearchId}
                  onAction={onAction}
                />
              </ResultCard>
            );
          case "media":
            return (
              <ResultCard key={index} title="媒体搜索结果" summary={`${view.items.length} 个匹配`}>
                <section className="media-grid" aria-label="媒体搜索结果">
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
              </ResultCard>
            );
          case "resources":
            return (
              <ResultCard
                key={view.searchId}
                title="资源搜索结果"
                summary={`${view.media.title} · 匹配 ${view.total} 条`}
              >
                <ResourceView
                  view={view}
                  api={api}
                  conversationId={conversationId}
                  onAction={onAction}
                  busy={busy}
                  current={view.searchId === currentSearchId}
                />
              </ResultCard>
            );
          case "confirmation":
            return (
              <TaskList
                key={index}
                items={[currentTask(view.task)]}
                busy={busy}
                onAction={onAction}
              />
            );
          case "tasks":
            return (
              <TaskList
                key={index}
                items={view.items.map(currentTask)}
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
              <ResultCard key={index} title="订阅" summary={`${view.items.length} 个订阅`}>
                <section>
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
              </ResultCard>
            );
        }
      })}
    </div>
  );
}
