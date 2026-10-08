import { test } from "node:test";
import assert from "node:assert/strict";
import { MoviePilotClient } from "../src/integrations/moviepilot.js";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { BackendBusyError } from "../src/core/errors.js";
import { setImmediate } from "node:timers/promises";
import { media, resource, mikanRelease } from "./fixtures.js";

test("Mikan adapter sends the original Chinese query to the native plugin without media lookup", async () => {
  const query = { keyword: "花织", group: "喵萌奶茶屋" };
  const page = {
    searchUrl: "https://mikan.example/Home/Search?searchstr=花织",
    received: 1,
    items: [mikanRelease("动画 [01][1080p][CHS]", 1)],
  };
  const client = new MoviePilotClient(
    { baseUrl, apiKey: "integration-key" },
    async (url, options) => {
      assert.equal(String(url), `${baseUrl}plugin/PiAgentBridge/mikan_search`);
      assert.equal(options?.method, "POST");
      assert.deepEqual(JSON.parse(String(options?.body)), query);
      return Response.json({ success: true, data: page });
    },
  );
  assert.deepEqual(await client.searchMikan(query), page);
});

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
    Response.json({ success: false, message: "115 未登录，请重新登录" }),
  );
  await assert.rejects(rejected.submit115(["magnet"]), /115 未登录，请重新登录/);
  const uncertain = new MoviePilotClient(
    { baseUrl, accessToken: "secret" },
    async () => new Response("private information", { status: 503 }),
  );
  await assert.rejects(uncertain.submit115(["magnet"]), /不确定/);
});

test("115 waits for an explicitly rejected busy RSS job and starts one accepted job", async () => {
  const bodies: unknown[] = [];
  const client = new MoviePilotClient({ baseUrl, apiKey: "test-key" }, async (_url, options) => {
    bodies.push(JSON.parse(String(options?.body)));
    return bodies.length < 3
      ? Response.json({ success: false, message: "已有任务在运行，请稍后重试" })
      : Response.json({ success: true, data: { id: "accepted-job" } });
  });
  assert.equal(await client.submit115(["magnet-one", "magnet-two"]), "accepted-job");
  assert.deepEqual(
    bodies,
    Array.from({ length: 3 }, () => ({ links: "magnet-one\nmagnet-two", force: false })),
  );
});

test("115 busy timeout and cancelled waiting mean no accepted submission", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  let calls = 0;
  const client = new MoviePilotClient({ baseUrl, apiKey: "test-key" }, async () => {
    calls++;
    return Response.json({ success: false, message: "已有任务在运行，请稍后重试" });
  });
  const timedOut = assert.rejects(client.submit115(["magnet"]), BackendBusyError);
  await setImmediate();
  t.mock.timers.tick(120_000);
  await timedOut;
  assert.equal(calls, 2);
  const controller = new AbortController();
  const cancelled = assert.rejects(
    client.submit115(["magnet"], controller.signal),
    BackendBusyError,
  );
  await setImmediate();
  controller.abort();
  await cancelled;
  assert.equal(calls, 3);
});

test("115 never repeats uncertain or incomplete accepted writes, and redacts credentials in rejection details", async () => {
  for (const response of [
    () => new Response("backend unavailable", { status: 503 }),
    () => Response.json({ success: true, data: {} }),
  ]) {
    let calls = 0;
    const client = new MoviePilotClient({ baseUrl, apiKey: "test-key" }, async () => {
      calls++;
      return response();
    });
    await assert.rejects(client.submit115(["magnet"]), /不确定/);
    assert.equal(calls, 1);
  }
  const client = new MoviePilotClient({ baseUrl, apiKey: "private-integration-key" }, async () =>
    Response.json({ success: false, message: "无效密钥 private-integration-key，请检查配置" }),
  );
  await assert.rejects(client.submit115(["magnet"]), (error: Error) => {
    assert.match(error.message, /无效密钥 \[REDACTED\]/);
    assert.doesNotMatch(error.message, /private-integration-key/);
    return true;
  });
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

test("official Feishu SDK exposes normalized events, streaming and shutdown without connecting", async () => {
  const channel = createLarkChannel({
    appId: "cli_0000000000000000",
    appSecret: "offline-test",
    loggerLevel: LoggerLevel.error,
  });
  assert.equal(typeof channel.on, "function");
  assert.equal(typeof channel.stream, "function");
  await channel.disconnect();
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
