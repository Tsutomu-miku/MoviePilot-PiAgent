import { ConflictError } from "./errors.js";

export class ConversationQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly depths = new Map<string, number>();
  private stopped = false;

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    if (this.stopped) {
      return Promise.reject(new ConflictError("Agent 服务正在停止"));
    }
    const depth = this.depths.get(key) ?? 0;
    if (depth >= 100) {
      return Promise.reject(new ConflictError("该会话的待处理消息过多，请稍后再试"));
    }
    this.depths.set(key, depth + 1);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(() => {
      if (this.stopped) {
        throw new ConflictError("Agent 服务正在停止");
      }
      return operation();
    });
    const release = () => {
      const remaining = (this.depths.get(key) ?? 1) - 1;
      if (remaining === 0) {
        this.depths.delete(key);
        this.tails.delete(key);
      } else {
        this.depths.set(key, remaining);
      }
    };
    // The tail represents completion; the caller receives the original result and error.
    this.tails.set(key, result.then(release, release));
    return result;
  }

  isBusy(key: string): boolean {
    return this.tails.has(key);
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.all(this.tails.values());
  }
}
