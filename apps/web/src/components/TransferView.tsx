import { useState } from "react";
import type { View, UserAction } from "@mp-pi/contracts";

interface Props {
  view: Extract<View, { kind: "transfer_failures" }>;
  busy: boolean;
  current: boolean;
  onAction(action: UserAction, label: string): void;
}

export function TransferView({ view, busy, current, onAction }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const disabled = busy || !current;
  return (
    <section aria-label="整理失败记录">
      <div className="section-heading">
        <strong>整理失败 · 共 {view.total} 条</strong>
        <span>第 {view.page} 页</span>
      </div>
      <p className="muted">可继续用文字指定正确片名和季集，再预览重新整理。</p>
      {view.items.length === 0 && <p>当前没有匹配的失败记录。</p>}
      {view.items.map((item) => (
        <article className="media-card" key={item.id}>
          <label className="transfer-selection">
            <input
              type="checkbox"
              aria-label={`选择整理记录 ${item.id}`}
              checked={selected.includes(item.id)}
              disabled={disabled}
              onChange={(event) =>
                setSelected((ids) =>
                  event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id),
                )
              }
            />
            <strong>
              #{item.id} · {item.filename}
            </strong>
          </label>
          <p>{item.error}</p>
          {item.identification && (
            <p>
              将识别为：{item.identification.media.title} · {item.identification.media.year}
              {item.identification.season !== undefined
                ? ` · 第 ${item.identification.season} 季`
                : ""}
              {item.identification.episodes
                ? ` · 集数 ${item.identification.episodes.join("、")}`
                : ""}
            </p>
          )}
          <small className="muted">{item.date}</small>
        </article>
      ))}
      <div className="button-row">
        <button
          disabled={disabled || selected.length === 0}
          onClick={() =>
            onAction(
              { type: "prepare_transfer_retry", searchId: view.searchId, historyIds: selected },
              `预览重新整理 ${selected.length} 条记录`,
            )
          }
        >
          预览所选记录
        </button>
        <button
          disabled={disabled || view.page <= 1}
          onClick={() =>
            onAction(
              { type: "transfer_failures", title: view.title, page: view.page - 1 },
              "上一页整理失败记录",
            )
          }
        >
          上一页
        </button>
        <button
          disabled={disabled || view.page * view.count >= view.total}
          onClick={() =>
            onAction(
              { type: "transfer_failures", title: view.title, page: view.page + 1 },
              "下一页整理失败记录",
            )
          }
        >
          下一页
        </button>
      </div>
      {!current && <p className="muted">列表已更新，请使用最新的整理记录。</p>}
    </section>
  );
}
