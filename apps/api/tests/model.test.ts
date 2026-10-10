import { test } from "node:test";
import assert from "node:assert/strict";
import { configureModel } from "../src/core/model.js";
import { fixture } from "./fixtures.js";

test("native provider requests honor configured output limits and context budget", async (t) => {
  const f = await fixture(t);
  const models = f.options.modelRuntime;
  const native = models.getModel("openrouter", "deepseek/deepseek-v4.1-flash");
  assert.ok(native);
  await models.setRuntimeApiKey("openrouter", "offline-api-key");
  const model = configureModel(native, { contextWindow: 128000, maxTokens: 8192 });
  assert.equal(model.contextWindow, 128000);
  assert.equal(model.maxTokens, 8192);
  assert.equal(models.getModel(native.provider, native.id)?.maxTokens, native.maxTokens);
  let payload: Record<string, unknown> | undefined;
  const result = await models
    .streamSimple(
      model,
      {
        messages: [{ role: "user", content: "测试", timestamp: Date.now() }],
      },
      {
        fetch: async (url, options) => {
          payload = await new Request(url, options).json();
          const chunk = {
            id: "test",
            choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
          };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { "Content-Type": "text/event-stream" },
          });
        },
      },
    )
    .result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(payload?.max_completion_tokens, 8192);
  assert.equal(payload?.model, native.id);
  assert.deepEqual(result.content, [{ type: "text", text: "OK" }]);
});

test("configured budgets retain provider capability limits and transport", async (t) => {
  const f = await fixture(t);
  const model = f.options.model;
  const configured = configureModel(model, {
    contextWindow: model.contextWindow + 1,
    maxTokens: model.maxTokens + 1,
  });
  assert.equal(configured.contextWindow, model.contextWindow);
  assert.equal(configured.maxTokens, model.maxTokens);
  assert.equal(configured.baseUrl, model.baseUrl);
  assert.equal(configured.api, model.api);
});
