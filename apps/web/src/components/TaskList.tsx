import { stateLabels, type TaskSummary, type UserAction } from "@mp-pi/contracts";

interface Props {
  items: TaskSummary[];
  busy?: boolean;
  onAction?(action: UserAction, label: string, conversationId: string): void;
}

export function TaskList({ items, busy = false, onAction }: Props) {
  return (
    <div className="task-list">
      {items.length === 0 && <p className="muted">还没有任务。搜索媒体或粘贴链接后即可创建。</p>}
      {items.map((task) => (
        <article key={task.id} className={`task task-${task.state}`}>
          <div className="section-heading">
            <strong>{task.title}</strong>
            <span className="status">{stateLabels[task.state]}</span>
          </div>
          <p className="muted">
            {task.destination === "115" ? "115" : "MoviePilot"} ·{" "}
            {new Date(task.createdAt).toLocaleString()}
          </p>
          <p>{task.message}</p>
          {task.progress !== undefined && (
            <div className="progress-row">
              <progress value={task.progress} max={100} aria-label="下载进度" />
              <span>{task.progress.toFixed(0)}%</span>
            </div>
          )}
          {task.playUrl && (
            <a href={task.playUrl} target="_blank" rel="noreferrer">
              打开媒体库 ↗
            </a>
          )}
          {task.state === "awaiting_confirmation" && task.confirmationToken && onAction && (
            <div className="button-row">
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  onAction(
                    { type: "confirm", taskId: task.id, token: task.confirmationToken! },
                    `确认执行：${task.title}`,
                    task.conversationId,
                  )
                }
              >
                确认执行
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  onAction(
                    { type: "cancel", taskId: task.id },
                    `取消：${task.title}`,
                    task.conversationId,
                  )
                }
              >
                取消
              </button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
