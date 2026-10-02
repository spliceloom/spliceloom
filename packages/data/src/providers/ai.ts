/**
 * AI providers: OpenRouter (primary) and Gemini (optional second provider).
 *
 * Both are called directly over HTTPS through the Splice network guard; keys come only from
 * OPENROUTER_API_KEY / GEMINI_API_KEY and never appear in results or errors. Responses are
 * normalized (text, tool calls, finish reason, usage, actual model, upstream provider) — nothing
 * is generated locally. Health checks are free metadata calls, never completions.
 */
import type { Scope } from "../chains.js";
import type { HttpClient, RequestOptions } from "../http.js";
import type { ProviderCapability, ProviderData, ProviderKind } from "../provider.js";
import { ProviderError } from "../result.js";

export type AiContentPart = { type: "text"; text: string } | { type: "image_url"; url: string };

export interface AiToolCall {
  id?: string;
  name: string;
  /** JSON-encoded arguments exactly as the model produced them. */
  arguments: string;
}

export interface AiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | AiContentPart[];
  /** tool messages: the call being answered (OpenRouter) / function name (Gemini). */
  toolCallId?: string;
  name?: string;
  /** assistant messages that requested tools (for multi-turn tool use). */
  toolCalls?: AiToolCall[];
}

export interface AiTool {
  name: string;
  description?: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface AiRequest {
  model: string;
  messages: AiMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: AiTool[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  /** Structured output: the model must answer with JSON matching this schema. */
  responseSchema?: { name: string; schema: Record<string, unknown>; strict?: boolean };
  /** Reasoning effort for models that support it. */
  reasoning?: { effort: "low" | "medium" | "high" };
  timeoutMs?: number;
}

export interface AiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  /** Cost reported by the provider (OpenRouter usage accounting), USD. */
  costUsd?: number;
}

export interface AiResponse {
  provider: string;
  /** Model that actually answered, as reported by the provider. */
  model: string;
  /** Upstream inference provider OpenRouter routed to (e.g. "OpenAI"), when reported. */
  upstreamProvider?: string;
  id?: string;
  text?: string;
  toolCalls?: AiToolCall[];
  /** Parsed JSON of a structured-output answer (absent when the output was not valid JSON). */
  structured?: unknown;
  finishReason?: string;
  usage?: AiUsage;
}

export interface AiModel {
  id: string;
  name?: string;
  provider: string;
  contextLength?: number;
  /** USD per token, as published by the provider. */
  pricing?: { prompt?: string; completion?: string };
  inputModalities?: string[];
  outputModalities?: string[];
  supportsTools?: boolean;
  supportsStructuredOutput?: boolean;
}

export interface AiProvider {
  readonly name: string;
  generate(request: AiRequest): Promise<ProviderData<AiResponse>>;
  models(): Promise<ProviderData<AiModel[]>>;
}

export const AI_CAPABILITIES: ProviderCapability[] = ["ai.generate", "ai.tools", "ai.structured_output", "ai.multimodal", "ai.reason", "ai.models"];

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v.length ? v : undefined);
function prune<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
function parseJson(text: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (text === undefined) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) };
  } catch {
    return { ok: false };
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One retry for transient failures (network, 5xx, 429 with a short retry-after). */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const e = error as ProviderError;
    const transient = e instanceof ProviderError && (e.kind === "network" || (e.kind === "http" && (e.status ?? 0) >= 500) || (e.kind === "rate_limited" && (e.retryAfter ?? 1) <= 5));
    if (!transient) throw error;
    await sleep(e.kind === "rate_limited" ? (e.retryAfter ?? 1) * 1000 : 750);
    return fn();
  }
}

// ------------------------------------------------------------------------------------ OpenRouter

const OPENROUTER = "https://openrouter.ai/api/v1";

export class OpenRouterProvider implements AiProvider {
  readonly name = "openrouter";
  readonly kind: ProviderKind = "ai";
  readonly chains = ["global"];
  readonly capabilities = AI_CAPABILITIES;
  readonly auth = "Bearer API key (OPENROUTER_API_KEY)";
  readonly envVars = ["OPENROUTER_API_KEY"];
  readonly endpoint = `${OPENROUTER}/chat/completions`;
  readonly rateLimit = "Per account/key credits; HTTP 402 when credits run out, 429 when rate limited";
  readonly docs = "https://openrouter.ai/docs/api-reference/overview";
  readonly verification = "see docs/data-providers.md (live-tested: chat completion, tool calling, structured output, image input, model list, usage/cost metadata)";
  readonly unconfigured: string | null;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
  ) {
    this.unconfigured = apiKey ? null : "OPENROUTER_API_KEY is not set";
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "http-referer": "https://github.com/spliceloom", "x-title": "Splice" };
  }

  private mapError = (status: number, headers: Headers, detail: string): ProviderError | undefined => {
    let message = detail;
    try {
      message = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? detail;
    } catch {
      /* keep the raw detail */
    }
    const text = `OpenRouter HTTP ${status}: ${message}`;
    if (status === 401) return new ProviderError(text, "auth", status);
    if (status === 429) {
      const retry = Number(headers.get("retry-after") ?? "NaN");
      return new ProviderError(text, "rate_limited", status, Number.isFinite(retry) ? retry : undefined);
    }
    // 400 invalid request/model, 403 moderation, 404 no endpoint supports the requested features,
    // 413/422: this request is refused as such — no fallback would make it valid.
    if ([400, 403, 404, 413, 422].includes(status)) return new ProviderError(text, "rejected", status);
    // 402 (credits), 408, 5xx: provider-side failure; configured fallbacks may be tried.
    return new ProviderError(text, "http", status);
  };

  async generate(request: AiRequest): Promise<ProviderData<AiResponse>> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) =>
        prune({
          role: m.role,
          content: typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: p.url } })),
          tool_call_id: m.toolCallId,
          name: m.role === "tool" ? undefined : m.name,
          tool_calls: m.toolCalls?.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } })),
        }),
      ),
      usage: { include: true },
    };
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools?.length) body.tools = request.tools.map((t) => ({ type: "function", function: prune({ name: t.name, description: t.description, parameters: t.parameters }) }));
    if (request.toolChoice) body.tool_choice = typeof request.toolChoice === "string" ? request.toolChoice : { type: "function", function: { name: request.toolChoice.name } };
    if (request.responseSchema) body.response_format = { type: "json_schema", json_schema: { name: request.responseSchema.name, strict: request.responseSchema.strict ?? true, schema: request.responseSchema.schema } };
    if (request.reasoning) body.reasoning = { effort: request.reasoning.effort };
    const options: RequestOptions = { timeoutMs: request.timeoutMs ?? 60_000, mapError: this.mapError };
    const res = await withRetry(() => this.http.json<Record<string, any>>(`${OPENROUTER}/chat/completions`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, options));
    const b = res.body;
    // OpenRouter can report a provider error inside a 200 response.
    if (b?.error) throw new ProviderError(this.http.redact(`OpenRouter: ${b.error.message ?? JSON.stringify(b.error).slice(0, 200)}`), (b.error.code ?? 500) >= 500 ? "http" : "rejected", num(b.error.code));
    const choice = Array.isArray(b?.choices) ? b.choices[0] : undefined;
    if (!choice?.message) throw new ProviderError("OpenRouter returned no choices", "invalid_response");
    const msg = choice.message as Record<string, any>;
    const text = typeof msg.content === "string" ? msg.content : undefined;
    const toolCalls: AiToolCall[] | undefined = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls.map((t: any) => prune({ id: str(t.id), name: String(t.function?.name ?? ""), arguments: String(t.function?.arguments ?? "") })) : undefined;
    const u = (b.usage ?? {}) as Record<string, any>;
    const usage = prune({ promptTokens: num(u.prompt_tokens), completionTokens: num(u.completion_tokens), totalTokens: num(u.total_tokens), reasoningTokens: num(u.completion_tokens_details?.reasoning_tokens), costUsd: num(u.cost) });
    const out: AiResponse = prune({ provider: this.name, model: str(b.model) ?? request.model, upstreamProvider: str(b.provider), id: str(b.id), text: text && text.length ? text : undefined, toolCalls, finishReason: str(choice.finish_reason), usage: Object.keys(usage).length ? usage : undefined });
    const notes: string[] = [];
    if (request.responseSchema) {
      const parsed = parseJson(text);
      if (parsed.ok) out.structured = parsed.value;
      else notes.push("structured output requested but the model's answer is not valid JSON; `structured` is absent and `text` is the raw answer");
    }
    if (out.model !== request.model) notes.push(`requested model ${request.model}; provider reports ${out.model}`);
    const data: ProviderData<AiResponse> = { data: out, resource: "chat/completions" };
    if (out.id) data.requestId = out.id;
    if (notes.length) data.notes = notes;
    return data;
  }

  async models(): Promise<ProviderData<AiModel[]>> {
    const res = await withRetry(() => this.http.json<{ data?: Array<Record<string, any>> }>(`${OPENROUTER}/models`, { headers: this.headers() }, { mapError: this.mapError, maxBytes: 20 * 1024 * 1024 }));
    const models = (res.body.data ?? []).map((m) => {
      const params: string[] = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
      return prune({
        id: String(m.id),
        name: str(m.name),
        provider: this.name,
        contextLength: num(m.context_length),
        pricing: m.pricing ? prune({ prompt: str(m.pricing.prompt), completion: str(m.pricing.completion) }) : undefined,
        inputModalities: Array.isArray(m.architecture?.input_modalities) ? m.architecture.input_modalities : undefined,
        outputModalities: Array.isArray(m.architecture?.output_modalities) ? m.architecture.output_modalities : undefined,
        supportsTools: params.length ? params.includes("tools") : undefined,
        supportsStructuredOutput: params.length ? params.includes("structured_outputs") || params.includes("response_format") : undefined,
      }) as AiModel;
    });
    return { data: models, resource: "models" };
  }

  /** Free metadata call: validates the key and reports the remaining credit limit, never a completion. */
  async check(_scope: Scope): Promise<{ detail: string }> {
    const res = await this.http.json<{ data?: Record<string, any> }>(`${OPENROUTER}/key`, { headers: this.headers() }, { mapError: this.mapError });
    const d = res.body.data ?? {};
    const remaining = num(d.limit_remaining);
    return { detail: `key accepted${remaining !== undefined ? `; key spending limit remaining ${remaining} USD (per-key limit, not the account balance)` : ""}${d.is_free_tier === true ? "; free tier" : ""}` };
  }

}

// ---------------------------------------------------------------------------------------- Gemini

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";

export class GeminiProvider implements AiProvider {
  readonly name = "gemini";
  readonly kind: ProviderKind = "ai";
  readonly chains = ["global"];
  readonly capabilities = AI_CAPABILITIES;
  readonly auth = "API key header x-goog-api-key (GEMINI_API_KEY)";
  readonly envVars = ["GEMINI_API_KEY"];
  readonly endpoint = `${GEMINI}/models/{model}:generateContent`;
  readonly rateLimit = "Per project quota (requests and tokens per minute); HTTP 429 when exceeded";
  readonly docs = "https://ai.google.dev/api";
  readonly verification = "see docs/data-providers.md (live-tested: generateContent, function calling, structured output, model list, usage)";
  readonly unconfigured: string | null;

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string | undefined,
  ) {
    this.unconfigured = apiKey ? null : "GEMINI_API_KEY is not set";
  }

  private headers(): Record<string, string> {
    return { "x-goog-api-key": this.apiKey ?? "", "content-type": "application/json" };
  }

  private mapError = (status: number, headers: Headers, detail: string): ProviderError | undefined => {
    let message = detail;
    try {
      message = (JSON.parse(detail) as { error?: { message?: string } }).error?.message ?? detail;
    } catch {
      /* raw */
    }
    const text = `Gemini HTTP ${status}: ${message}`;
    if (status === 401 || (status === 403 && /api key/i.test(message)) || (status === 400 && /api key not valid/i.test(message))) return new ProviderError(text, "auth", status);
    if (status === 429) return new ProviderError(text, "rate_limited", status, Number(headers.get("retry-after") ?? "NaN") || undefined);
    if ([400, 403, 404, 413].includes(status)) return new ProviderError(text, "rejected", status);
    return new ProviderError(text, "http", status);
  };

  private parts(content: string | AiContentPart[]): Array<Record<string, unknown>> {
    if (typeof content === "string") return [{ text: content }];
    return content.map((p) => {
      if (p.type === "text") return { text: p.text };
      const m = /^data:([^;,]+);base64,(.+)$/s.exec(p.url);
      if (!m) throw new ProviderError("Gemini accepts images here only as data: URLs (base64); http(s) image URLs are not fetched", "rejected");
      return { inline_data: { mime_type: m[1], data: m[2] } };
    });
  }

  async generate(request: AiRequest): Promise<ProviderData<AiResponse>> {
    const system = request.messages.filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("")));
    const contents = request.messages
      .filter((m) => m.role !== "system")
      .map((m) => {
        if (m.role === "tool") return { role: "user", parts: [{ functionResponse: { name: m.name ?? m.toolCallId ?? "tool", response: { content: typeof m.content === "string" ? m.content : JSON.stringify(m.content) } } }] };
        const parts = this.parts(m.content);
        for (const t of m.toolCalls ?? []) parts.push({ functionCall: { name: t.name, args: parseJson(t.arguments).ok ? (parseJson(t.arguments) as { value: unknown }).value : {} } });
        return { role: m.role === "assistant" ? "model" : "user", parts };
      });
    const generationConfig: Record<string, unknown> = {};
    if (request.maxTokens !== undefined) generationConfig.maxOutputTokens = request.maxTokens;
    if (request.temperature !== undefined) generationConfig.temperature = request.temperature;
    if (request.responseSchema) {
      generationConfig.responseMimeType = "application/json";
      generationConfig.responseJsonSchema = request.responseSchema.schema;
    }
    if (request.reasoning) generationConfig.thinkingConfig = { thinkingBudget: { low: 1024, medium: 4096, high: 16384 }[request.reasoning.effort] };
    const body: Record<string, unknown> = { contents };
    if (system.length) body.systemInstruction = { parts: [{ text: system.join("\n\n") }] };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
    if (request.tools?.length) body.tools = [{ functionDeclarations: request.tools.map((t) => prune({ name: t.name, description: t.description, parameters: t.parameters })) }];
    if (request.toolChoice) {
      const mode = typeof request.toolChoice === "string" ? { auto: "AUTO", none: "NONE", required: "ANY" }[request.toolChoice] : "ANY";
      body.toolConfig = { functionCallingConfig: prune({ mode, allowedFunctionNames: typeof request.toolChoice === "object" ? [request.toolChoice.name] : undefined }) };
    }
    const model = request.model.replace(/^models\//, "");
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) throw new ProviderError(`invalid Gemini model id: ${model}`, "rejected");
    const res = await withRetry(() => this.http.json<Record<string, any>>(`${GEMINI}/models/${model}:generateContent`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) }, { timeoutMs: request.timeoutMs ?? 60_000, mapError: this.mapError }));
    const b = res.body;
    const cand = Array.isArray(b?.candidates) ? b.candidates[0] : undefined;
    if (!cand) throw new ProviderError(`Gemini returned no candidates${b?.promptFeedback?.blockReason ? ` (blocked: ${b.promptFeedback.blockReason})` : ""}`, b?.promptFeedback?.blockReason ? "rejected" : "invalid_response");
    const parts: Array<Record<string, any>> = Array.isArray(cand.content?.parts) ? cand.content.parts : [];
    const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("");
    const toolCalls = parts.filter((p) => p.functionCall).map((p) => ({ name: String(p.functionCall.name), arguments: JSON.stringify(p.functionCall.args ?? {}) }));
    const u = (b.usageMetadata ?? {}) as Record<string, any>;
    const usage = prune({ promptTokens: num(u.promptTokenCount), completionTokens: num(u.candidatesTokenCount), totalTokens: num(u.totalTokenCount), reasoningTokens: num(u.thoughtsTokenCount) });
    const out: AiResponse = prune({ provider: this.name, model: str(b.modelVersion) ?? model, id: str(b.responseId), text: text.length ? text : undefined, toolCalls: toolCalls.length ? toolCalls : undefined, finishReason: str(cand.finishReason), usage: Object.keys(usage).length ? usage : undefined });
    const notes: string[] = [];
    if (request.responseSchema) {
      const parsed = parseJson(text || undefined);
      if (parsed.ok) out.structured = parsed.value;
      else notes.push("structured output requested but the model's answer is not valid JSON; `structured` is absent");
    }
    const data: ProviderData<AiResponse> = { data: out, resource: `models/${model}:generateContent` };
    if (out.id) data.requestId = out.id;
    if (notes.length) data.notes = notes;
    return data;
  }

  async models(): Promise<ProviderData<AiModel[]>> {
    const res = await this.http.json<{ models?: Array<Record<string, any>> }>(`${GEMINI}/models?pageSize=1000`, { headers: this.headers() }, { mapError: this.mapError });
    const models = (res.body.models ?? []).map((m) =>
      prune({
        id: String(m.name ?? "").replace(/^models\//, ""),
        name: str(m.displayName),
        provider: this.name,
        contextLength: num(m.inputTokenLimit),
      }) as AiModel,
    );
    return { data: models, resource: "models" };
  }

  async check(_scope: Scope): Promise<{ detail: string }> {
    await this.http.json(`${GEMINI}/models?pageSize=1`, { headers: this.headers() }, { mapError: this.mapError });
    return { detail: "key accepted (model list)" };
  }
}
