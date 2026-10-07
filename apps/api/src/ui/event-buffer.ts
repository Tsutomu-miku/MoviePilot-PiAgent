import type { UiEvent } from "@mp-pi/contracts";

export class EventBuffer {
  private readonly events: UiEvent[] = [];
  private wake?: () => void;
  private ended = false;

  push(event: UiEvent): void {
    if (this.ended) {
      return;
    }
    this.events.push(event);
    this.wake?.();
  }

  close(): void {
    this.ended = true;
    this.wake?.();
  }

  async *read(): AsyncGenerator<UiEvent> {
    while (!this.ended || this.events.length > 0) {
      const event = this.events.shift();
      if (event) {
        yield event;
      } else {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
      }
    }
  }
}
