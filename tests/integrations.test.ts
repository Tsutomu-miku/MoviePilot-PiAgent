import { test } from "node:test";
import assert from "node:assert/strict";
import { MoviePilotClient } from "../src/integrations/moviepilot.js";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";

test("MoviePilot client uses the API prefix and bearer header without query credentials", async () => {
  const request: typeof fetch = async (url, options) => {
    assert.equal(String(url), "http://moviepilot:3000/api/v1/download/");
    assert.equal((options?.headers as Record<string, string>).Authorization, "Bearer test-token");
    assert.equal(options?.redirect, "error");
    return new Response(JSON.stringify([{ hash: "task-1" }]), { headers: { "content-type": "application/json" } });
  };
  const client = new MoviePilotClient("http://moviepilot:3000/api/v1", "test-token", request);
  assert.deepEqual(await client.getDownloading(), [{ hash: "task-1" }]);
});

test("MoviePilot errors never echo server response bodies or credentials", async () => {
  const client = new MoviePilotClient("http://moviepilot/api/v1/", "secret", async () =>
    new Response("private config", { status: 401 }));
  await assert.rejects(client.getDownloading(), error =>
    error instanceof Error && error.message === "MoviePilot returned HTTP 401");
});

test("published Feishu TS SDK exposes the normalized UI channel and close lifecycle", async () => {
  const channel = createLarkChannel({ appId: "cli_0000000000000000", appSecret: "offline-test", loggerLevel: LoggerLevel.error });
  assert.equal(typeof channel.on, "function");
  assert.equal(typeof channel.stream, "function");
  assert.equal(typeof channel.send, "function");
  await channel.disconnect();
});
