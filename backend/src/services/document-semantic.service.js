import { createHash } from "node:crypto";
import { knowledgeCloudAllowed, knowledgeKeyConfigured, knowledgeOpenRouterJson } from './knowledge-ai.service.js';
import { withKnowledgeTransaction } from './knowledge-wiki-store.service.js';

// 조직 문서 전용 사용자별 파생 인덱스. 개인 Vault 캐시/설정과 섞지 않는다.
export const DOCUMENT_CANDIDATE_LIMIT = 32;
const MAX_SCOPES = 64;
const MAX_DOCUMENTS = 1000;
const MAX_JOBS = 64;
const THRESHOLD = 0.82;

export const documentSemanticScope = (principal) => JSON.stringify([
  "document",
  "sqlite",
  principal.tenantId,
  principal.orgId,
  principal.userId,
]);
export const pgDocumentSemanticScope = (identity) => JSON.stringify([
  "document",
  "pg",
  identity.companyId,
  identity.userId,
]);

function scopeContext(scope) {
  const [,store,a,b,c]=JSON.parse(scope);
  return store==='pg' ? {store:'pg',scope:'company',companyId:a,actorId:b} : {store:'legacy',scope:'company',tenantId:a,companyId:b,actorId:c};
}
function configuration(scope) {
  const local=localConfiguration(), context=scopeContext(scope);
  if (!knowledgeKeyConfigured(context)) return {...local,local};
  const model=process.env.ORBITFLOW_DOCUMENT_OPENROUTER_EMBEDDING_MODEL?.trim();
  return {key:`openrouter:${model}:${local.key}`,provider:'openrouter',model,context,local,
    reason:model ? null : 'embedding_model_not_configured'};
}
function forDocument(config,document) {
  return config.provider==='openrouter' && !knowledgeCloudAllowed(document.sensitivity) ? config.local : config;
}
function localConfiguration() {
  const model = process.env.ORBITFLOW_DOCUMENT_EMBEDDING_MODEL?.trim();
  const base = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  let url;
  try {
    url = new URL(base);
  } catch {
    return { key: base, reason: "local_endpoint_required" };
  }
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  if (
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.protocol !== "http:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    return { key: `${base}:${model}`, reason: "local_endpoint_required" };
  }
  return {
    key: `${url.origin}:${model}:document-v1`,
    model,
    endpoint: `${url.origin}/api/embed`,
    reason: model ? null : "model_not_configured",
  };
}

const fingerprint = (document, config) => createHash("sha256")
  .update(JSON.stringify([document.id, document.version, document.title, document.content, config.key]))
  .digest("hex");

function boundedSet(map, key, value, limit = MAX_DOCUMENTS) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
}

async function authorizeCloudDocuments(context,documents) {
  return withKnowledgeTransaction(context,{},function*(tx) {
    for (const document of documents) {
      const current=yield* tx.origin('document',document.id);
      if (!current || current.version!==String(document.version) || current.title!==document.title || current.content!==document.content || !knowledgeCloudAllowed(current.restrictions.sensitivity)) throw new Error('document_access_changed');
    }
  });
}
async function embeddings(config, documents) {
  if (config.provider==='openrouter') {
    if (!documents.every(document=>knowledgeCloudAllowed(document.sensitivity))) throw new Error('external_data_blocked');
    const metadata=await knowledgeOpenRouterJson(config.context,'/embeddings/models');
    const model=metadata.data?.find(item=>item.id===config.model && item.architecture?.output_modalities?.includes('embeddings'));
    if (!model) throw new Error('embedding_model_unsupported');
    const input=documents.map(document=>`${document.title}\n${document.content ?? ''}`.slice(0,6000));
    if (!Number.isSafeInteger(model.context_length) || input.some(text=>Buffer.byteLength(text)+32>model.context_length)) throw new Error('embedding_context_limit');
    // 대기/모델 조회 중 발생한 원본 변경, 등급 변경, 권한 회수를 전송 직전에 재검사한다.
    await authorizeCloudDocuments(config.context,documents);
    const payload=await knowledgeOpenRouterJson(config.context,'/embeddings',{body:{model:config.model,input,encoding_format:'float'}});
    if (!Array.isArray(payload.data) || payload.data.length!==documents.length || new Set(payload.data.map(item=>item.index)).size!==documents.length || payload.data.some(item=>!Number.isInteger(item.index)||item.index<0||item.index>=documents.length)) throw new Error('invalid_embeddings');
    return normalizeVectors(payload.data.sort((a,b)=>a.index-b.index).map(item=>item.embedding),documents.length);
  }
  const response = await fetch(config.endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(6000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      input: documents.map((document) => `${document.title}\n${document.content ?? ""}`.slice(0, 6000)),
      truncate: true,
      keep_alive: "5m",
    }),
  });
  if (!response.ok) throw new Error("inference_unavailable");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4_000_000) throw new Error("invalid_embeddings");
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }

  let vectors;
  try {
    vectors = JSON.parse(text).embeddings;
  } catch {
    throw new Error("invalid_embeddings");
  }
  return normalizeVectors(vectors,documents.length);
}
function normalizeVectors(vectors,count) {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new Error("invalid_embeddings");
  const dimension = vectors[0]?.length;
  if (!Number.isInteger(dimension) || dimension < 2 || dimension > 8192) throw new Error("invalid_embeddings");
  return vectors.map((vector) => {
    if (
      !Array.isArray(vector) ||
      vector.length !== dimension ||
      !vector.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
      throw new Error("invalid_embeddings");
    }
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm === 0) throw new Error("invalid_embeddings");
    return vector.map((value) => value / norm);
  });
}

class DocumentSemanticService {
  scopes = new Map();
  queue = [];
  active = 0;

  state(scope) {
    const config = configuration(scope);
    let state = this.scopes.get(scope);
    if (!state || state.config.key !== config.key) {
      state = {
        config,
        statuses: new Map(),
        versions: new Map(),
        vectors: new Map(),
        edges: new Map(),
        jobs: new Map(),
      };
      boundedSet(this.scopes, scope, state, MAX_SCOPES);
    }
    return state;
  }

  invalidate(scope, id, version = null) {
    const state = this.state(scope);
    boundedSet(state.versions, id, version);
    state.statuses.delete(id);
    for (const [key, edge] of state.edges) {
      if (edge.source === id || edge.target_id === id) state.edges.delete(key);
    }
    for (const [key, value] of state.vectors) {
      if (value.id === id) state.vectors.delete(key);
    }
  }

  status(scope, document) {
    const state = this.state(scope);
    const config=forDocument(state.config,document);
    const status = state.statuses.get(document.id);
    return status?.version === document.version
      ? status
      : {
          state: config.reason ? "unavailable" : "not_analyzed",
          reason: config.reason ?? "cache_empty",
          version: document.version,
          model: config.model ?? null,
          local_only: config.provider !== 'openrouter',
        };
  }

  schedule(scope, document, loadCandidates) {
    const state = this.state(scope);
    const config=forDocument(state.config,document);
    const current = state.jobs.get(document.id);
    if (current?.version === document.version) return this.status(scope, document);
    boundedSet(state.versions, document.id, document.version);
    const status = {
      state: "pending",
      version: document.version,
      model: config.model ?? null,
      local_only: config.provider !== 'openrouter',
      candidate_limit: DOCUMENT_CANDIDATE_LIMIT,
    };
    boundedSet(state.statuses, document.id, status);
    if (config.reason || this.queue.length + this.active >= MAX_JOBS) {
      status.state = "unavailable";
      status.reason = config.reason ?? "queue_full";
      return status;
    }
    const done = Promise.withResolvers();
    const job = { scope, state, config, document, loadCandidates, version: document.version, status, done };
    state.jobs.set(document.id, job);
    this.queue.push(job);
    queueMicrotask(() => this.drain());
    return status;
  }

  drain() {
    while (this.active < 2 && this.queue.length > 0) {
      const job = this.queue.shift();
      this.active += 1;
      void this.run(job).finally(() => {
        this.active -= 1;
        job.done.resolve();
        if (job.state.jobs.get(job.document.id) === job) job.state.jobs.delete(job.document.id);
        this.drain();
      });
    }
  }

  async run(job) {
    const { scope, state, config, document, status } = job;
    const current = () => this.scopes.get(scope) === state &&
      state.versions.get(document.id) === document.version &&
      state.jobs.get(document.id) === job;
    try {
      if (!current()) return;
      const candidates = (await job.loadCandidates())
        .filter((candidate) => candidate.id !== document.id && (config.provider !== 'openrouter' || knowledgeCloudAllowed(candidate.sensitivity)))
        .slice(0, DOCUMENT_CANDIDATE_LIMIT);
      const documents = [document, ...candidates];
      for (const candidate of documents) {
        if (!state.versions.has(candidate.id)) boundedSet(state.versions, candidate.id, candidate.version);
      }
      const keys = documents.map((candidate) => fingerprint(candidate, config));
      const missing = documents.filter((_, index) => !state.vectors.has(keys[index]));
      if (missing.length > 0) {
        const vectors = await embeddings(config, missing);
        if (!current()) return;
        missing.forEach((candidate, index) => boundedSet(
          state.vectors,
          fingerprint(candidate, config),
          { id: candidate.id, vector: vectors[index] },
        ));
      }
      if (!current()) return;
      if (config.provider==='openrouter') await authorizeCloudDocuments(config.context,documents);
      const source = state.vectors.get(keys[0]).vector;
      const matches = [];
      candidates.forEach((target, index) => {
        if (state.versions.get(target.id) !== target.version) return;
        const vector = state.vectors.get(keys[index + 1]).vector;
        if (vector.length !== source.length) throw new Error("invalid_embeddings");
        const score = Math.max(-1, Math.min(1, source.reduce((sum, value, i) => sum + value * vector[i], 0)));
        if (score >= THRESHOLD) {
          matches.push({
            source: document.id,
            target_id: target.id,
            target_title: target.title,
            kind: "ai_similarity",
            score,
            provenance: {
              provider: config.provider ?? "ollama-local",
              model: config.model,
              method: "embedding_cosine",
              source_version: document.version,
              target_version: target.version,
              analyzed_at: new Date().toISOString(),
            },
          });
        }
      });
      for (const [key, edge] of state.edges) {
        if (edge.source === document.id || edge.target_id === document.id) state.edges.delete(key);
      }
      for (const edge of matches.sort((a, b) => b.score - a.score).slice(0, 5)) {
        boundedSet(state.edges, JSON.stringify([edge.source, edge.target_id].sort()), edge, MAX_DOCUMENTS * 5);
      }
      status.state = "ready";
      status.candidates = candidates.length;
      status.truncated = documents.some((candidate) => `${candidate.title}\n${candidate.content ?? ""}`.length > 6000);
    } catch (error) {
      if (current()) {
        const unavailable=['embedding_model_unsupported','embedding_context_limit','document_access_changed'];
        status.state = unavailable.includes(error.message) || error.status===503 ? 'unavailable' : 'error';
        status.reason = ['invalid_embeddings',...unavailable].includes(error.message) ? error.message : 'inference_unavailable';
      }
    }
  }

  async wait(scope, id) {
    const state = this.state(scope);
    const jobs = id ? [state.jobs.get(id)].filter(Boolean) : [...state.jobs.values()];
    if (jobs.length === 0) return;
    let timer;
    try {
      await Promise.race([
        Promise.all(jobs.map((job) => job.done.promise)),
        new Promise((resolve) => { timer = setTimeout(resolve, 7000); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  graph(scope, documents) {
    const state = this.state(scope);
    const known = new Map(documents.map((document) => [document.id, document]));
    const edges = [...state.edges.values()].filter((edge) =>
      known.get(edge.source)?.version === edge.provenance.source_version &&
      known.get(edge.target_id)?.version === edge.provenance.target_version,
    );
    return {
      edges,
      analysis: documents.map((document) => ({ id: document.id, ...this.status(scope, document) })),
    };
  }
}

export const documentSemantic = new DocumentSemanticService();
