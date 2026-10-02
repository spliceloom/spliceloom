# AI providers

Splice can call language models for agents and skills — with explicit routing, usage reporting and
no hidden provider substitution.

| Provider | Configuration | Status |
| --- | --- | --- |
| OpenRouter (default) | `OPENROUTER_API_KEY`, `AI_DEFAULT_MODEL` | verified live: completions, tool calling, structured output, image input, model list, usage and cost |
| Gemini | `GEMINI_API_KEY`, `GEMINI_DEFAULT_MODEL` | verified live: completions, function calling, structured output, model list |

## Use it

```sh
splice ai models --search gpt-4o
splice ai generate "Explain EIP-1967 in one sentence" --max-tokens 80
splice ai generate "Reply with one word" --provider gemini
splice ai generate "Capital of France as JSON" --schema schema.json
```

From TypeScript:

```ts
const r = await splice.ai.generate({ prompt: "…", maxTokens: 200 });
if (isLive(r)) console.log(r.data.text, r.data.usage, r.data.routing);
```

Over MCP (with `splice mcp --data`): `ai_generate` and `ai_models`. Skills use the `ai.generate`
host capability ([Host capabilities](capabilities.md)); their output is capped at 2,048 tokens per call.

## Routing

- A request uses the requested provider (or `AI_PROVIDER`, default `openrouter`) and the requested
  model (or the provider's default model). No model is hardcoded in Splice.
- Nothing else is tried unless `AI_FALLBACK_PROVIDER` **and** `AI_FALLBACK_MODEL` are set and the
  request does not pass `fallback: false`.
- Every answer carries `routing`: requested and actual provider and model, whether a fallback was
  used and why. OpenRouter's upstream provider (e.g. "OpenAI", "Azure") is reported too.

## Limits and behaviour

- Up to 100 messages and 200,000 characters per request; `maxTokens` up to 16,384; up to 32 tools;
  images as https or `data:image/*` URLs (Gemini: `data:` URLs only).
- Timeout 60 seconds by default (maximum 120); one retry for network errors, 5xx and short
  rate-limit waits.
- Invalid requests (unknown model, bad schema) are `PROVIDER_ERROR` without fallback; missing
  credits or provider outages may use the configured fallback.
- Completions are never cached. Health checks use free metadata calls (OpenRouter `/key`, Gemini
  model list), never a completion.
- Streaming is not offered: results are complete objects with provenance.

Keys stay in the host process and are redacted from every result and error.
