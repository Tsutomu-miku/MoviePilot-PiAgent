import type { TaskSummary, View } from "@mp-pi/contracts";

export function finalizeReplyViews(views: View[], tasks: TaskSummary[]): View[] {
  const currentTasks = new Map(tasks.map((task) => [task.id, task]));
  const pendingIds = new Set(
    views.flatMap((view) =>
      view.kind === "confirmation" &&
      currentTasks.get(view.task.id)?.state === "awaiting_confirmation"
        ? [view.task.id]
        : [],
    ),
  );
  const latest = new Set<string>();
  const result: View[] = [];
  for (const view of [...views].reverse()) {
    if (view.kind === "confirmation") {
      const task = currentTasks.get(view.task.id)!;
      if (task.state === "awaiting_confirmation" && !latest.has(task.id)) {
        latest.add(task.id);
        result.push({ kind: "confirmation", task });
      }
    } else if (view.kind === "tasks") {
      if (!latest.has("tasks")) {
        latest.add("tasks");
        const items = tasks.filter((task) => !pendingIds.has(task.id));
        if (items.length > 0 || pendingIds.size === 0) {
          result.push({ kind: "tasks", items });
        }
      }
    } else if (view.kind === "library") {
      result.push(view);
    } else if (!latest.has(view.kind)) {
      latest.add(view.kind);
      result.push(view);
    }
  }
  return result.reverse();
}
