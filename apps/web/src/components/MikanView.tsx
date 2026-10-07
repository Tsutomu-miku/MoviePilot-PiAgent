import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { UserAction, View } from "@mp-pi/contracts";
import { ApiClient } from "../api";
import { MikanSearchForm } from "./MikanSearchForm";

export function MikanView({
  view,
  conversationId,
  api,
  busy,
  current,
  onAction,
}: {
  view: Extract<View, { kind: "mikan" }>;
  conversationId: string;
  api: ApiClient;
  busy: boolean;
  current: boolean;
  onAction(action: UserAction, label: string): void;
}) {
  const [offset, setOffset] = useState(view.offset);
  const [selected, setSelected] = useState<string[]>([]);
  const page = useQuery({
    queryKey: ["mikan-resources", conversationId, view.searchId, offset],
    queryFn: () => api.mikanResources(conversationId, view.searchId, offset),
    initialData: offset === view.offset ? view : undefined,
    enabled: current,
    staleTime: Infinity,
  });
  const disabled = busy || !current || page.isFetching;
  return (
    <section className="mikan-results" aria-label="蜜柑搜索结果">
      <div className="section-heading">
        <h3>蜜柑 · {view.query.keyword}</h3>
        <a href={view.searchUrl} target="_blank" rel="noreferrer">
          在蜜柑打开 ↗
        </a>
      </div>
      <p className="muted">
        本次 RSS 返回 {view.received} 条，筛选后 {view.total} 条。
      </p>
      {!current && <p className="muted">已被新的蜜柑搜索替换。</p>}
      <MikanSearchForm
        initial={view.query}
        disabled={disabled}
        onSubmit={(query) =>
          onAction({ type: "mikan_search", query }, `搜索蜜柑：${query.keyword}`)
        }
      />
      {page.error && (
        <p role="alert" className="error">
          {page.error.message}
        </p>
      )}
      {page.isPending && <p>正在加载资源…</p>}
      {view.total === 0 && <p>没有匹配条目，可以尝试短关键词、别名或调整字幕组。</p>}
      <div className="resource-list">
        {page.data?.items.map((item) => (
          <article className="resource" key={item.id}>
            <label className="resource-selection">
              <input
                type="checkbox"
                aria-label={`选择 ${item.title}`}
                checked={selected.includes(item.id)}
                disabled={disabled || (selected.length >= 20 && !selected.includes(item.id))}
                onChange={(event) =>
                  setSelected((ids) =>
                    event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id),
                  )
                }
              />
              <strong>{item.title}</strong>
            </label>
            <p className="muted">
              {item.group ?? "字幕组未标注"} · {item.sizeGiB} GiB ·{" "}
              {item.publishedAt.replace("T", " ")}
            </p>
            <div className="tags">
              {[
                item.tags.resolution,
                ...item.tags.subtitles,
                item.tags.episodes?.length ? `集数 ${item.tags.episodes.join(", ")}` : undefined,
              ]
                .filter(Boolean)
                .map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
            </div>
            <a href={item.sourceUrl} target="_blank" rel="noreferrer">
              发布详情 ↗
            </a>
          </article>
        ))}
      </div>
      <div className="button-row">
        <button
          disabled={disabled || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 20))}
        >
          上一页
        </button>
        <span>
          {view.total
            ? `${offset + 1}–${Math.min(offset + 20, view.total)} / ${view.total}`
            : "0 条"}
        </span>
        <button
          disabled={disabled || offset + 20 >= view.total}
          onClick={() => setOffset(offset + 20)}
        >
          下一页
        </button>
        <button
          className="primary"
          disabled={disabled || selected.length === 0}
          onClick={() =>
            onAction(
              { type: "prepare_mikan_download", searchId: view.searchId, resourceIds: selected },
              `预览 ${selected.length} 个蜜柑资源到 115`,
            )
          }
        >
          预览到 115（{selected.length}）
        </button>
      </div>
    </section>
  );
}
