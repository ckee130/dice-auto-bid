/** DeepSeek's OpenAI-compatible chat API, shared by all generation paths. */
export async function callDeepSeek(request, ProviderError) {
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey}` },
    signal: request.signal,
    body: JSON.stringify({
      model: request.model,
      messages: [{ role: "system", content: request.system }, ...request.messages],
      max_tokens: request.maxTokens,
      temperature: request.temperature,
      thinking: { type: "disabled" },
      ...(request.format === "json" ? { response_format: { type: "json_object" } } : {}),
      stream: false,
    }),
  });
  if (!response.ok) {
    // Do not echo response bodies, which may contain request credentials.
    throw new ProviderError(`DeepSeek request failed (HTTP ${response.status}). Check your key, model and account balance.`, response.status, "deepseek");
  }
  const payload = await response.json();
  const choice = payload.choices?.[0];
  if (choice?.finish_reason === "length") {
    throw new ProviderError("DeepSeek's response exceeded the token limit. Try a larger token budget or another model.", 400, "deepseek");
  }
  if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()) {
    throw new ProviderError("DeepSeek returned an empty response.", 502, "deepseek");
  }
  return {
    text: choice.message.content,
    inputTokens: payload.usage?.prompt_tokens,
    outputTokens: payload.usage?.completion_tokens,
    cachedTokens: payload.usage?.prompt_cache_hit_tokens,
  };
}
