import type { TaskState } from "@mp-pi/contracts";
import type { StateStore } from "../core/store.js";
import type { Task } from "../domain/types.js";
import type { MediaBackend } from "../integrations/moviepilot.js";
import type { OfflineTask } from "../integrations/moviepilot-contracts.js";
import { AppError } from "../core/errors.js";

export interface TrackerOptions {
  intervalMs: number;
  moviePilotUtcOffsetMinutes: number;
  onTransition(task: Task): Promise<void>;
  onError(error: unknown): void;
}

export class TaskTracker {
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;
  private readonly abort = new AbortController();

  constructor(
    private readonly store: StateStore,
    private readonly backend: MediaBackend,
    private readonly options: TrackerOptions,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.refresh().catch(this.options.onError);
    }, this.options.intervalMs);
    this.timer.unref();
  }

  refresh(): Promise<void> {
    this.polling ??= this.poll().finally(() => {
      this.polling = undefined;
    });
    return this.polling;
  }

  private async transition(task: Task, state: TaskState, message: string): Promise<void> {
    task.state = state;
    task.message = message;
    task.updatedAt = new Date().toISOString();
    this.store.saveTask(task);
  }

  private historyTime(date: string): number {
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(date)) {
      throw new Error("MoviePilot 历史记录时间格式不符合约定");
    }
    return (
      Date.parse(`${date.replace(" ", "T")}Z`) - this.options.moviePilotUtcOffsetMinutes * 60_000
    );
  }

  private async trackNative(task: Task): Promise<void> {
    const hashes = task.backendId
      ? [task.backendId]
      : task.payload.kind === "resource"
        ? task.payload.infoHashes
        : [];
    if (hashes.length === 0) {
      return;
    }
    const downloads = await this.backend.getDownloadStates(hashes, this.abort.signal);
    const download = downloads.find((item) => hashes.includes(item.hash));
    if (download) {
      task.progress = download.progress;
      await this.transition(
        task,
        download.completed ? "downloaded" : "downloading",
        download.completed ? "下载器报告下载完成" : "下载器正在下载",
      );
    }
    if (task.payload.kind !== "resource") {
      return;
    }
    const history = await this.backend.getTransferHistory(task.payload.media, this.abort.signal);
    // Correlate the transfer by both the download hash and the canonical media ID.
    const payload = task.payload;
    const ownTransfer = history.some(
      (item) =>
        item.status &&
        item.download_hash !== null &&
        hashes.includes(item.download_hash) &&
        item.media_source === payload.media.source &&
        item.media_id === payload.media.id &&
        this.historyTime(item.date) >= Date.parse(task.createdAt) - 1000,
    );
    if (ownTransfer) {
      await this.transition(task, "downloaded", "MoviePilot 已完成该任务的整理");
    }
    if (task.state === "downloaded" && (!payload.libraryBefore || ownTransfer)) {
      await this.trackLibrary(task);
    }
  }

  private async trackOffline(task: Task, offline: OfflineTask[]): Promise<void> {
    if (task.payload.kind !== "resource" && task.payload.kind !== "links") {
      return;
    }
    const hashes = task.payload.infoHashes;
    const matched = hashes.map((hash) =>
      offline.find((item) => item.info_hash.toLowerCase() === hash),
    );
    const failed = matched.find((item) => item?.status === 1);
    if (failed) {
      await this.transition(
        task,
        "failed",
        `115 报告离线任务失败：${failed.name}。同批其他链接可能仍在下载，请核对 115 任务列表。`,
      );
      return;
    }
    const allFound = matched.every((item) => item !== undefined);
    const allComplete = allFound && matched.every((item) => item?.status === 2);
    if (matched.some((item) => item !== undefined)) {
      task.progress =
        matched.reduce((total, item) => total + (item?.percent ?? 0), 0) / hashes.length;
      await this.transition(
        task,
        allComplete ? "downloaded" : "downloading",
        allComplete ? "115 报告全部离线链接下载完成" : "正在跟踪 115 离线任务",
      );
    } else if (task.state === "submitted") {
      const submission = await this.backend.get115Submission(this.abort.signal);
      if (
        submission.id === task.backendId &&
        submission.status !== "running" &&
        submission.failed > 0
      ) {
        await this.transition(task, "failed", "115 提交批次包含失败链接，请核对插件记录。");
      }
    }
    if (
      task.state === "downloaded" &&
      task.payload.kind === "resource" &&
      !task.payload.libraryBefore
    ) {
      await this.trackLibrary(task);
    }
  }

  private async trackLibrary(task: Task): Promise<void> {
    if (task.payload.kind !== "resource") {
      return;
    }
    const library = await this.backend.checkLibrary(
      task.payload.media,
      task.payload.criteria,
      this.abort.signal,
    );
    if (library.exists) {
      task.playUrl = library.playUrl;
      await this.transition(task, "imported", "媒体服务器已确认目标内容入库");
    }
  }

  private async poll(): Promise<void> {
    try {
      await this.pollTasks();
    } finally {
      for (const task of this.store.pendingNotifications()) {
        try {
          await this.options.onTransition(task);
          task.notifiedState = task.state;
          this.store.saveTask(task);
        } catch (error) {
          this.options.onError(error);
        }
      }
    }
  }

  private async pollTasks(): Promise<void> {
    const tasks = this.store.activeTasks().filter((task) => task.kind === "download");
    let failed = false;
    const reportFailure = (task: Task, error: unknown) => {
      failed = true;
      this.store.saveTask({
        ...task,
        message: "本次状态查询失败，保留最近一次已确认的进度。请检查后端连接。",
      });
      this.options.onError(error);
    };
    for (const task of tasks.filter((item) => item.destination === "moviepilot")) {
      try {
        await this.trackNative(task);
      } catch (error) {
        reportFailure(task, error);
      }
    }
    const offlineTasks = tasks.filter((item) => item.destination === "115");
    if (offlineTasks.length > 0) {
      let offline: OfflineTask[];
      try {
        offline = await this.backend.get115Tasks(this.abort.signal);
      } catch (error) {
        for (const task of offlineTasks) {
          reportFailure(task, error);
        }
        throw new AppError("TRACKING_FAILED", "115 状态无法核对，请检查后端连接", 502);
      }
      for (const task of offlineTasks) {
        try {
          await this.trackOffline(task, offline);
        } catch (error) {
          reportFailure(task, error);
        }
      }
    }
    if (failed) {
      throw new AppError("TRACKING_FAILED", "部分任务状态无法核对，请检查后端连接", 502);
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.abort.abort();
    await this.polling?.catch(this.options.onError);
  }
}
