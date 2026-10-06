import { createHash } from "node:crypto";
import type { Destination, TaskPayload } from "./types.js";

export function taskHashes(payload: TaskPayload): string[] {
  if (payload.kind === "resource" || payload.kind === "links") {
    return payload.infoHashes;
  }
  return [];
}

export function submissionKey(destination: Destination, payload: TaskPayload): string {
  let identity: unknown[];
  switch (payload.kind) {
    case "resource":
      identity = [destination, payload.media.key, payload.resource.torrent.enclosure];
      break;
    case "links":
      identity = [destination, [...payload.infoHashes].sort()];
      break;
    case "subscription":
      identity = [payload.kind, payload.media.key, payload.season];
      break;
    case "subscription_change":
      identity = [payload.kind, payload.subscriptionId, payload.operation];
      break;
  }
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}
