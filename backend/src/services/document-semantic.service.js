import { createHash } from "node:crypto";

// 조직 문서 전용 로컬 파생 인덱스. 개인 Vault 캐시/설정과 섞지 않는다.
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
]);
export const pgDocumentSemanticScope = (identity) => JSON.stringify([
  "document",
  "pg",
  identity.companyId,
]);

function configuration() {
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

async function embeddings(config, documents) {
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
  if (!Array.isArray(vectors) || vectors.length !== documents.length) throw new Error("invalid_embeddings");
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
    const config = configuration();
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
    const status = state.statuses.get(document.id);
    return status?.version === document.version
      ? status
      : {
          state: state.config.reason ? "unavailable" : "not_analyzed",
          reason: state.config.reason ?? "cache_empty",
          version: document.version,
          model: state.config.model ?? null,
          local_only: true,
        };
  }

  schedule(scope, document, loadCandidates) {
    const state = this.state(scope);
    const current = state.jobs.get(document.id);
    if (current?.version === document.version) return this.status(scope, document);
    boundedSet(state.versions, document.id, document.version);
    const status = {
      state: "pending",
      version: document.version,
      model: state.config.model ?? null,
      local_only: true,
      candidate_limit: DOCUMENT_CANDIDATE_LIMIT,
    };
    boundedSet(state.statuses, document.id, status);
    if (state.config.reason || this.queue.length + this.active >= MAX_JOBS) {
      status.state = "unavailable";
      status.reason = state.config.reason ?? "queue_full";
      return status;
    }
    const done = Promise.withResolvers();
    const job = { scope, state, document, loadCandidates, version: document.version, status, done };
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
    const { scope, state, document, status } = job;
    const current = () => this.scopes.get(scope) === state &&
      state.versions.get(document.id) === document.version &&
      state.jobs.get(document.id) === job;
    try {
      if (!current()) return;
      const candidates = (await job.loadCandidates())
        .filter((candidate) => candidate.id !== document.id)
        .slice(0, DOCUMENT_CANDIDATE_LIMIT);
      const documents = [document, ...candidates];
      for (const candidate of documents) {
        if (!state.versions.has(candidate.id)) boundedSet(state.versions, candidate.id, candidate.version);
      }
      const keys = documents.map((candidate) => fingerprint(candidate, state.config));
      const missing = documents.filter((_, index) => !state.vectors.has(keys[index]));
      if (missing.length > 0) {
        const vectors = await embeddings(state.config, missing);
        if (!current()) return;
        missing.forEach((candidate, index) => boundedSet(
          state.vectors,
          fingerprint(candidate, state.config),
          { id: candidate.id, vector: vectors[index] },
        ));
      }
      if (!current()) return;
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
              provider: "ollama-local",
              model: state.config.model,
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
        status.state = "error";
        status.reason = error.message === "invalid_embeddings" ? "invalid_embeddings" : "inference_unavailable";
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
