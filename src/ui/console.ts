import type { AgentInput, UiAdapter, UiEvent } from "../core/contracts.js";

export class ConsoleUi implements UiAdapter {
  constructor(private readonly write = (text: string) => { process.stdout.write(text); }) {}
  publish(_input: AgentInput, event: UiEvent): void {
    if (event.type === "text_delta") this.write(event.text);
    if (event.type === "tool_start") this.write(`\n[${event.name}]\n`);
  }
}
