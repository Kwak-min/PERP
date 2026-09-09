import { env } from "../config/env.js";

export const EXTERNAL_BLOCKED_CLASSES = new Set(["sensitive", "confidential"]);
const DATA_CLASSES = new Set(["public", "internal", "personal", ...EXTERNAL_BLOCKED_CLASSES]);

class EchoProvider {
  constructor() {
    this.name = "echo";
    this.local = true;
  }

  available() {
    return true;
  }

  async complete(model, system, user) {
    const started = Date.now();
    const text = user.trim();
    return {
      text,
      model: model || "echo-local",
      provider: this.name,
      prompt_tokens: Math.max(1, Math.floor((system.length + user.length) / 4)),
      completion_tokens: Math.max(1, Math.floor(text.length / 4)),
      latency_ms: Date.now() - started,
      cost_micro: 0,
      error: null,
    };
  }
}

class HttpChatProvider {
  constructor(name, baseUrl, apiKey = "", local = false) {
    this.name = name;
    this.baseUrl = (baseUrl ?? "").replace(/\/$/, "");
    this.apiKey = apiKey;
    this.local = local;
  }

  available() {
    if (!this.baseUrl) return false;
    if (!this.local && !this.apiKey) return false;
    return true;
  }

  async complete(model, system, user, options = {}) {
    const started = Date.now();
    let failure = `${this.name} request failed`;
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          stream: false,
          ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        }),
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 60000),
      });
      if (!response.ok) {
        failure = `${this.name} returned HTTP ${response.status}`;
        throw new Error(failure);
      }
      const payload = await response.json();
      const choice = payload.choices?.[0] ?? {};
      if (typeof choice.message?.content !== "string" || !choice.message.content.trim()) {
        throw new Error("모델 응답 형식이 올바르지 않습니다");
      }
      const usage = payload.usage ?? {};
      return {
        text: choice.message?.content ?? "",
        model: payload.model ?? model,
        provider: this.name,
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        latency_ms: Date.now() - started,
        cost_micro: (usage.total_tokens ?? 0) * 2,
        error: null,
      };
    } catch {
      // 공급자 본문/네트워크 오류에는 인증 정보가 포함될 수 있어 고정 오류만 반환한다.
      return {
        text: "",
        model,
        provider: this.name,
        prompt_tokens: 0,
        completion_tokens: 0,
        latency_ms: Date.now() - started,
        cost_micro: 0,
        error: failure,
      };
    }
  }
}

export const REGISTRY = {
  echo: new EchoProvider(),
  ollama: new HttpChatProvider("ollama", `${env.ollamaBaseUrl}/v1`, "", true),
  openrouter: new HttpChatProvider("openrouter", env.openrouterBaseUrl, env.openrouterApiKey, false),
};

export function openRouterForKey(apiKey) {
  return new HttpChatProvider("openrouter", env.openrouterBaseUrl, apiKey, false);
}

export function externalAllowed(dataClass) {
  return DATA_CLASSES.has(dataClass) && !EXTERNAL_BLOCKED_CLASSES.has(dataClass);
}

export function route(dataClass, prefer = null, externalProvider = REGISTRY.openrouter) {
  const localChain = [
    [REGISTRY.ollama, env.localModel],
    [REGISTRY.echo, "echo-local"],
  ];
  const externalChain = [[externalProvider, env.externalModel]];

  if (!externalAllowed(dataClass)) return localChain;
  if (prefer === "local") return localChain;
  if (prefer === "external") return externalChain;
  if (env.aiProvider === "echo") return [[REGISTRY.echo, "echo-local"]];
  return [...externalChain, ...localChain];
}

export async function complete(dataClass, system, user, prefer = null, externalProvider = REGISTRY.openrouter) {
  const attempted = [];
  let last = null;
  for (const [provider, model] of route(dataClass, prefer, externalProvider)) {
    if (!provider.available()) {
      attempted.push(`${provider.name}:unavailable`);
      continue;
    }
    const result = await provider.complete(model, system, user);
    if (!result.error) return result;
    attempted.push(`${provider.name}:${result.error.slice(0, 60)}`);
    last = result;
  }
  if (last) {
    last.error = attempted.join("; ");
    return last;
  }
  return {
    text: "",
    model: "none",
    provider: "none",
    prompt_tokens: 0,
    completion_tokens: 0,
    latency_ms: 0,
    cost_micro: 0,
    error: `no provider available: ${attempted.join("; ")}`,
  };
}
