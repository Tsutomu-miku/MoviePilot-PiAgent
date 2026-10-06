import { useState } from "react";
import type { UserAction, View } from "@mp-pi/contracts";
import { ApiClient } from "../api";
import { CriteriaForm } from "./CriteriaForm";

interface Props {
  view: Extract<View, { kind: "resources" }>;
  conversationId: string;
  api: ApiClient;
  onAction(action: UserAction, label: string): void;
  busy: boolean;
  current: boolean;
}

export function ResourceView({ view, conversationId, api, onAction, busy, current }: Props) {
  const [page, setPage] = useState(view);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState("");
  async function changePage(next: number) {
    try {
      const result = await api.resources(conversationId, view.searchId, next);
      if (result.kind !== "resources") {
        throw new Error("资源 API 返回了错误的视图类型");
      }
      setPage(result);
      setOffset(next);
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "获取资源失败");
    }
  }
  return (
    <section className="results" aria-label="资源搜索结果">
      <div className="section-heading">
        <h3>{view.media.title}</h3>
        <span>匹配 {view.total} 条</span>
      </div>
      {!current && <p className="muted">条件已更新，请使用最新结果。</p>}
      <details>
        <summary>筛选与排序条件</summary>
        <CriteriaForm
          initial={view.criteria}
          showSeason={view.media.type === "电视剧"}
          disabled={busy || !current}
          submitLabel="更新筛选"
          onSubmit={(criteria) =>
            onAction({ type: "filter", searchId: view.searchId, criteria }, "更新资源筛选")
          }
        />
      </details>
      {view.total === 0 && <p className="muted">没有符合全部条件的资源，可以调整筛选条件。</p>}
      {page.items.map((resource) => (
        <article className="resource" key={resource.id}>
          <strong>{resource.title}</strong>
          <p className="muted">
            {resource.site} · {resource.sizeGiB.toFixed(1)} GiB · 做种 {resource.seeders}
          </p>
          <div className="tags">
            {[
              resource.tags.resolution,
              resource.tags.channels,
              ...resource.tags.audio,
              ...resource.tags.subtitles,
              resource.tags.source,
            ]
              .filter(Boolean)
              .map((tag, index) => (
                <span key={`${tag}-${index}`}>{tag}</span>
              ))}
          </div>
          <div className="button-row">
            <button
              disabled={busy || !current}
              onClick={() =>
                onAction(
                  {
                    type: "prepare_download",
                    searchId: view.searchId,
                    resourceId: resource.id,
                    destination: "moviepilot",
                  },
                  `下载到 MP：${resource.title}`,
                )
              }
            >
              下载到 MP
            </button>
            <button
              disabled={busy || !current}
              onClick={() =>
                onAction(
                  {
                    type: "prepare_download",
                    searchId: view.searchId,
                    resourceId: resource.id,
                    destination: "115",
                  },
                  `推送到 115：${resource.title}`,
                )
              }
            >
              推送到 115
            </button>
          </div>
        </article>
      ))}
      {view.total > 50 && (
        <div className="button-row">
          <button
            disabled={!current || offset === 0}
            onClick={() => {
              void changePage(offset - 50);
            }}
          >
            上一页
          </button>
          <span>
            {offset + 1}–{Math.min(offset + 50, view.total)}
          </span>
          <button
            disabled={!current || offset + 50 >= view.total}
            onClick={() => {
              void changePage(offset + 50);
            }}
          >
            下一页
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
