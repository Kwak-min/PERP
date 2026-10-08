import { env } from "../config/env.js";
import { ApiError } from "../utils/errors.js";

export const EXTERNAL_BLOCKED_CLASSES = new Set(["sensitive", "confidential"]);
const DATA_CLASSES = new Set(["public", "internal", "personal", ...EXTERNAL_BLOCKED_CLASSES]);
const CLASS_ORDER = [...DATA_CLASSES];

// 명시된 등급은 낮추지 않으며, 오래된 대화와 관측값의 자격증명도 다시 검사한다.
export function classifyAgentContent(value, classification = "internal") {
  let rank = CLASS_ORDER.indexOf(classification);
  if (rank < 0) rank = CLASS_ORDER.length - 1;
  const inspect = (item) => {
    if (typeof item === "string") {
      if (/(?:password|passwd|api[_ -]?key|secret|비밀번호|암호)\s*["']?\s*[:=]\s*\S|Bearer\s+\S+|\bsk-[a-z0-9_-]{8,}|\b\d{6}-\d{7}\b/i.test(item)) rank = 4;
    } else if (Array.isArray(item)) {
      item.forEach(inspect);
    } else if (item && typeof item === "object") {
      for (const [key, entry] of Object.entries(item)) {
        if (["classification", "sensitivity", "data_class"].includes(key)) {
          const declared = CLASS_ORDER.indexOf(entry);
          rank = Math.max(rank, declared < 0 ? 4 : declared);
        }
        if (/^(?:reauth_password|password|passwd|api[_-]?key|access_token|refresh_token|secret)$/i.test(key)) rank = 4;
        inspect(entry);
      }
    }
  };
  inspect(value);
  return CLASS_ORDER[rank];
}

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

  async completeTurn(model, { messages, tools, classification, signal, response_format }) {
    const started = Date.now();
    if (!this.local && !externalAllowed(classifyAgentContent(messages, classification))) {
      throw new ApiError("PERMISSION_DENIED", "이 데이터는 외부 모델로 전송할 수 없습니다.");
    }
    const deadline = signal ?? AbortSignal.timeout(60000);
    try {
      deadline.throwIfAborted();
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({
          model,
          messages: messages.map(({ role, content, tool_calls, tool_call_id }) => ({
            role, content, ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}),
          })),
          ...(tools.length ? { tools, tool_choice: "auto" } : {}),
          ...(response_format ? { response_format } : {}),
          stream: false,
        }),
        redirect: "error",
        signal: deadline,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("provider_http");
      }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 262144) throw new Error("provider_bytes");
        chunks.push(chunk);
      }
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const choice = payload.choices?.[0];
      const message = choice?.message;
      if (!message || (choice.finish_reason && !["stop", "tool_calls"].includes(choice.finish_reason))
        || (message.content != null && typeof message.content !== "string")
        || (message.tool_calls !== undefined && !Array.isArray(message.tool_calls))
        || (!message.content?.trim() && !message.tool_calls?.length)) throw new Error("provider_format");
      const count = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
      return {
        content: message.content ?? "",
        tool_calls: message.tool_calls ?? [],
        provider: this.name,
        model: typeof payload.model === "string" ? payload.model : model,
        usage: {
          prompt_tokens: count(payload.usage?.prompt_tokens),
          completion_tokens: count(payload.usage?.completion_tokens),
          cost_micro: count(payload.usage?.total_tokens) * 2,
          latency_ms: Date.now() - started,
        },
      };
    } catch {
      // 인증 정보가 들어갈 수 있는 공급자 응답과 예외 원문을 전달하지 않는다.
      throw new ApiError("SERVICE_UNAVAILABLE", "AI 모델 요청을 완료하지 못했습니다.", {
        reason: deadline.aborted ? "aborted" : "provider_failure",
      });
    }
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

export async function completeTurn({ messages, tools = [], classification, signal, beforeDispatch, response_format }, prefer = null, externalProvider = REGISTRY.openrouter) {
  const effective = classifyAgentContent(messages, classification ?? "confidential");
  const local = prefer === "local" || !externalAllowed(effective);
  // Agent는 echo나 실패 후 대체 응답을 실제 관측으로 보고하지 않는다.
  const provider = local ? REGISTRY.ollama : externalProvider?.available() ? externalProvider : REGISTRY.ollama;
  if ((!local && prefer === "external" && !externalProvider?.available()) || !provider?.available()) {
    throw new ApiError("SERVICE_UNAVAILABLE", "사용 가능한 AI 모델 연결이 없습니다.", { reason: "provider_unavailable" });
  }
  const model = provider.local ? env.localModel : env.externalModel;
  const dispatch = { messages: structuredClone(messages), tools: structuredClone(tools), classification: effective, signal,
    ...(response_format ? { response_format: structuredClone(response_format) } : {}) };
  // 동의 검사 중 모델 설정이나 호출자 배열이 바뀌어도 검사한 전송 대상을 유지한다.
  if (beforeDispatch) await beforeDispatch(Object.freeze({ provider: provider.name, model, external: !provider.local }));
  return provider.completeTurn(model, dispatch);
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
