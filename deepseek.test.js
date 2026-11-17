import test from "node:test";
import assert from "node:assert/strict";
import { callModel, ProviderError } from "./src/vendor/generation.js";
import { checkWriter, defaultModel } from "./src/writer.js";

test("DeepSeek selection, request, usage and failures", async () => {
  assert.equal(defaultModel("deepseek"), "deepseek-flash");
  assert.equal(checkWriter({ provider: "deepseek", apiKey: "test-key" }).ok, true);
  assert.equal(checkWriter({ provider: "deepseek", apiKey: "" }).ok, false);
  const original = globalThis.fetch;
  const request = { provider: "deepseek", model: defaultModel("deepseek"), apiKey: "test-key", system: "Return JSON", messages: [{ role: "user", content: "Resume" }], format: "json", maxTokens: 12000 };
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, "https://api.deepseek.com/chat/completions");
      assert.equal(options.headers.Authorization, "Bearer test-key");
      const body = JSON.parse(options.body);
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.equal(body.messages[0].role, "system");
      return Response.json({ choices: [{ message: { content: '{"resume":true}' }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, prompt_cache_hit_tokens: 5 } });
    };
    assert.deepEqual(await callModel(request), { text: '{"resume":true}', inputTokens: 20, outputTokens: 10, cachedTokens: 5 });
    for (const status of [401, 402, 429, 500]) {
      globalThis.fetch = async () => new Response("private details", { status });
      await assert.rejects(callModel(request), error => error instanceof ProviderError && error.status === status && !error.message.includes("private details"));
    }
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: "partial" }, finish_reason: "length" }] });
    await assert.rejects(callModel(request), /token limit/);
    globalThis.fetch = async () => Response.json({ choices: [] });
    await assert.rejects(callModel(request), /empty response/);
  } finally {
    globalThis.fetch = original;
  }
});
