import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { MoviePilotClient } from "../src/integrations/moviepilot.js";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { media, resource } from "./fixtures.js";
import { viewCard } from "../src/ui/feishu-cards.js";

const baseUrl = "http://moviepilot:3000/api/v1/";

test("managed plugin uses MP API key without login or bearer credentials", async () => {
  let requests = 0;
  const request: typeof fetch = async (url, options) => {
    requests++;
    assert.equal(String(url), `${baseUrl}download/`);
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("x-api-key"), "integration-key");
    assert.equal(headers.has("authorization"), false);
    return Response.json([]);
  };
  const client = new MoviePilotClient({ baseUrl, apiKey: "integration-key" }, request);
  assert.deepEqual(await client.getDownloading(), []);
  assert.equal(requests, 1);
});

test("rejected MP integration key is not replaced with a guessed login method", async () => {
  let requests = 0;
  const request: typeof fetch = async () => {
    requests++;
    return Response.json({ message: "invalid key" }, { status: 401 });
  };
  const client = new MoviePilotClient({ baseUrl, apiKey: "invalid-key" }, request);
  await assert.rejects(client.getDownloading(), /HTTP 401/);
  assert.equal(requests, 1);
});

test("MP client uses the configured API prefix and bearer header, and strips private fields", async () => {
  const request: typeof fetch = async (url, options) => {
    assert.equal(String(url), `${baseUrl}download/`);
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test-token");
    assert.equal(options?.redirect, "error");
    return Response.json([
      {
        hash: "task-1",
        title: "Hamnet",
        state: "downloading",
        progress: 20,
        path: "private-path",
        trackers: ["private-passkey"],
      },
    ]);
  };
  const client = new MoviePilotClient({ baseUrl, accessToken: "test-token" }, request);
  assert.deepEqual(await client.getDownloading(), [
    { hash: "task-1", title: "Hamnet", state: "downloading", progress: 20 },
  ]);
});

test("MP errors never echo response bodies or credentials", async () => {
  const client = new MoviePilotClient(
    { baseUrl, accessToken: "secret" },
    async () => new Response("private config", { status: 401 }),
  );
  await assert.rejects(client.getDownloading(), /HTTP 401/);
});

test("MP submit preserves its declared native context and never retries uncertain writes", async () => {
  let calls = 0;
  const selected = resource("Hamnet.2160p.DDP5.1");
  const client = new MoviePilotClient(
    { baseUrl, accessToken: "secret", downloader: "qb", savePath: "/downloads" },
    async (_url, options) => {
      calls++;
      assert.deepEqual(JSON.parse(String(options?.body)), {
        media_in: media.raw,
        torrent_in: selected.torrent,
        downloader: "qb",
        save_path: "/downloads",
      });
      throw new TypeError("connection reset");
    },
  );
  await assert.rejects(client.submitDownload(media, selected), /不确定/);
  assert.equal(calls, 1);
});

test("MP explicitly rejected writes differ from server errors and incomplete acknowledgements", async () => {
  const rejected = new MoviePilotClient({ baseUrl, accessToken: "secret" }, async () =>
    Response.json({ success: false, message: "private information" }),
  );
  await assert.rejects(rejected.submit115(["magnet"]), /未接受/);
  const uncertain = new MoviePilotClient(
    { baseUrl, accessToken: "secret" },
    async () => new Response("private information", { status: 503 }),
  );
  await assert.rejects(uncertain.submit115(["magnet"]), /不确定/);
});

test("expired auth refreshes once for concurrent readers and uses configured login credentials", async () => {
  let logins = 0;
  const client = new MoviePilotClient(
    { baseUrl, username: "test-user", password: "test-password" },
    async (url, options) => {
      if (String(url).endsWith("login/access-token")) {
        logins++;
        assert.equal(String(options?.body), "username=test-user&password=test-password");
        await new Promise((resolve) => setTimeout(resolve, 10));
        return Response.json({ access_token: "new-token", expires_in: 1800 });
      }
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer new-token");
      return Response.json([]);
    },
  );
  await Promise.all([client.getDownloading(), client.getDownloading()]);
  assert.equal(logins, 1);
});

test("empty remote missing list establishes library presence while missing play URL stays absent", async () => {
  const client = new MoviePilotClient({ baseUrl, accessToken: "secret" }, async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/notexists")) {
      return Response.json([]);
    }
    if (path.endsWith("/exists")) {
      return Response.json({ success: false, data: { item: {} } });
    }
    throw new Error("Unexpected API call");
  });
  assert.deepEqual(await client.checkLibrary(media, {}), { exists: true, episodes: undefined });
});

test("official Feishu SDK exposes normalized events, message sending and shutdown without connecting", async () => {
  const channel = createLarkChannel({
    appId: "cli_0000000000000000",
    appSecret: "offline-test",
    loggerLevel: LoggerLevel.error,
  });
  assert.equal(typeof channel.on, "function");
  assert.equal(typeof channel.send, "function");
  await channel.disconnect();
});

test("official Feishu SDK sends text and operation cards without CardKit permission", async (t) => {
  const sent: Array<{ msg_type: string; content: string }> = [];
  const paths: string[] = [];
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://localhost").pathname;
    paths.push(path);
    response.setHeader("content-type", "application/json");
    if (path === "/open-apis/auth/v3/tenant_access_token/internal") {
      response.end(JSON.stringify({ code: 0, tenant_access_token: "offline-token", expire: 7200 }));
    } else if (path === "/open-apis/im/v1/messages") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      sent.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.end(JSON.stringify({ code: 0, data: { message_id: `om_test_${sent.length}` } }));
    } else {
      response.end(JSON.stringify({ code: 99991672, msg: "Access denied: cardkit:card:write" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.close();
    await once(server, "close");
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const channel = createLarkChannel({
    appId: "cli_0000000000000001",
    appSecret: "offline-test",
    domain: `http://127.0.0.1:${address.port}`,
    loggerLevel: LoggerLevel.error,
  });
  t.after(() => channel.disconnect());
  await channel.send("oc_test_chat", { text: "回复已完成" });
  await channel.send("oc_test_chat", {
    card: viewCard({ kind: "library", title: "测试电影", exists: true }, "conversation"),
  });
  assert.deepEqual(
    sent.map((item) => item.msg_type),
    ["text", "interactive"],
  );
  assert.equal(JSON.parse(sent[0]!.content).text, "回复已完成");
  assert.equal(
    paths.some((path) => path.includes("cardkit")),
    false,
  );
});

test("protocol mismatches fail at the adapter instead of guessing legacy response fields", async () => {
  const client = new MoviePilotClient({ baseUrl, accessToken: "secret" }, async () =>
    Response.json([{ id: "task", name: "legacy-name", status: "running" }]),
  );
  await assert.rejects(client.getDownloading(), /响应不符合约定/);
  const incomplete = new MoviePilotClient({ baseUrl, accessToken: "secret" }, async () =>
    Response.json({ success: true, data: {} }),
  );
  await assert.rejects(incomplete.submitDownload(media, resource("Movie.2160p")), /不确定/);
});
