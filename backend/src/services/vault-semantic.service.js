import { createHash } from "node:crypto";

// 자동 분석은 로컬 전용. 클라우드 결과는 명시적 범위 동의와 최신 검증을 통과한 경우에만 수락한다.
export const CANDIDATE_LIMIT = 32;
const MAX_SCOPES = 64, MAX_NOTES = 512, MAX_JOBS = 64;
const THRESHOLD = 0.82;
export const legacyVaultScope = p => JSON.stringify(["sqlite", p.tenantId, p.orgId, p.userId]);
export const pgVaultScope = identity => JSON.stringify(["pg", identity.userId]);

function configuration() {
  const model = process.env.ORBITFLOW_VAULT_EMBEDDING_MODEL?.trim();
  const base = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  let url;
  try { url = new URL(base); } catch { return { key: base, reason: "local_endpoint_required" }; }
  // DNS 재바인딩과 리다이렉트를 막기 위해 숫자 loopback 주소만 허용한다.
  if (url.hostname === "localhost") url.hostname = "127.0.0.1";
  if (!['127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== "http:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    return { key: `${base}:${model}`, reason: "local_endpoint_required" };
  }
  return { key: `${url.origin}:${model}:v1`, model, endpoint: `${url.origin}/api/embed`, reason: model ? null : "model_not_configured" };
}
const fingerprint = (note, config) => createHash("sha256").update(JSON.stringify([note.id, note.version, note.title, note.content, config.key])).digest("hex");
function boundedSet(map, key, value, limit = MAX_NOTES) {
  map.delete(key); map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value);
}
async function embeddings(config, notes) {
  const response = await fetch(config.endpoint, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(6000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.model, input: notes.map(n => `${n.title}\n${n.content ?? ""}`.slice(0, 6000)), truncate: true, keep_alive: "5m" }),
  });
  if (!response.ok) throw new Error("inference_unavailable");
  // 추론 출력도 신뢰 경계다. 응답 크기/벡터 차원/유한값/영벡터를 검증한다.
  const reader = response.body.getReader();
  let size = 0, text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; if (size > 4_000_000) throw new Error("invalid_embeddings");
      text += decoder.decode(value, { stream: true });
    }
  } finally { await reader.cancel(); }
  const vectors = JSON.parse(text).embeddings;
  if (!Array.isArray(vectors) || vectors.length !== notes.length) throw new Error("invalid_embeddings");
  const dimension = vectors[0]?.length;
  if (!Number.isInteger(dimension) || dimension < 2 || dimension > 8192) throw new Error("invalid_embeddings");
  return vectors.map(vector => {
    if (!Array.isArray(vector) || vector.length !== dimension || !vector.every(v => typeof v === "number" && Number.isFinite(v))) throw new Error("invalid_embeddings");
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm === 0) throw new Error("invalid_embeddings");
    return vector.map(v => v / norm);
  });
}

class VaultSemanticService {
  scopes = new Map();
  queue = [];
  active = 0;
  state(scope) {
    const config = configuration();
    let state = this.scopes.get(scope);
    if (!state || state.config.key !== config.key) {
      state = { config, statuses: new Map(), versions: new Map(), vectors: new Map(), edges: new Map(), jobs: new Map() };
      boundedSet(this.scopes, scope, state, MAX_SCOPES);
    }
    return state;
  }
  invalidate(scope, id, version = null) {
    const state = this.state(scope);
    boundedSet(state.versions, id, version);
    state.statuses.delete(id);
    for(const [key,status] of state.statuses)if(status.scope_versions?.some(n=>n.id===id))state.statuses.delete(key);
    for (const [key, edge] of state.edges) if (edge.source === id || edge.target_id === id || edge.provenance.scope_versions?.some(n=>n.id===id)) state.edges.delete(key);
    for (const [key, value] of state.vectors) if (value.id === id) state.vectors.delete(key);
  }
  status(scope, note) {
    const state = this.state(scope);
    const status = state.statuses.get(note.id);
    return status && String(status.version) === String(note.version) ? {...status,version:note.version} : { state: state.config.reason ? "unavailable" : "not_analyzed", reason: state.config.reason ?? "cache_empty", version: note.version, model: state.config.model ?? null, local_only: true };
  }
  schedule(scope, note, loadCandidates, disabled = false) {
    const state = this.state(scope), config = state.config;
    const current = state.jobs.get(note.id);
    if (current?.version === note.version) return this.status(scope, note);
    boundedSet(state.versions, note.id, note.version);
    const status = { state: "pending", version: note.version, model: config.model ?? null, local_only: true, candidate_limit: CANDIDATE_LIMIT };
    boundedSet(state.statuses, note.id, status);
    if (disabled || config.reason || this.queue.length + this.active >= MAX_JOBS) {
      status.state = "unavailable"; status.reason = disabled ? "note_ai_disabled" : config.reason ?? "queue_full"; return status;
    }
    const done = Promise.withResolvers();
    const job = { scope, state, note, loadCandidates, version: note.version, done, status };
    state.jobs.set(note.id, job); this.queue.push(job);
    // DB 저장 응답은 추론 완료를 기다리지 않는다.
    queueMicrotask(() => this.drain());
    return status;
  }
  drain() {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift(); this.active += 1;
      void this.run(job).finally(() => { this.active -= 1; job.done.resolve(); if (job.state.jobs.get(job.note.id) === job) job.state.jobs.delete(job.note.id); this.drain(); });
    }
  }
  async run(job) {
    const { scope, state, note, status } = job;
    const current = () => this.scopes.get(scope) === state && state.versions.get(note.id) === note.version && state.jobs.get(note.id) === job;
    try {
      if (!current()) return;
      const candidates = (await job.loadCandidates()).filter(n => n.id !== note.id).slice(0, CANDIDATE_LIMIT);
      const notes = [note, ...candidates];
      for (const n of notes) if (!state.versions.has(n.id)) boundedSet(state.versions, n.id, n.version);
      const keys = notes.map(n => fingerprint(n, state.config));
      const missing = notes.filter((_, i) => !state.vectors.has(keys[i]));
      if (missing.length) {
        const vectors = await embeddings(state.config, missing);
        if (!current()) return;
        missing.forEach((n, i) => boundedSet(state.vectors, fingerprint(n, state.config), { id: n.id, vector: vectors[i] }));
      }
      if (!current()) return;
      const source = state.vectors.get(keys[0]).vector;
      const matches = [];
      candidates.forEach((target, index) => {
        if (state.versions.get(target.id) !== target.version) return;
        const vector = state.vectors.get(keys[index + 1]).vector;
        if (vector.length !== source.length) throw new Error("invalid_embeddings");
        const score = Math.max(-1, Math.min(1, source.reduce((sum, v, i) => sum + v * vector[i], 0)));
        if (score >= THRESHOLD) matches.push({ source: note.id, target_id: target.id, target_title: target.title, kind: "ai_similarity", score,
          provenance: { provider: "ollama-local", model: state.config.model, method: "embedding_cosine", source_version: note.version, target_version: target.version, analyzed_at: new Date().toISOString() } });
      });
      for (const [key, edge] of state.edges) if (edge.source === note.id || edge.target_id === note.id) state.edges.delete(key);
      for (const edge of matches.sort((a, b) => b.score - a.score).slice(0, 5)) boundedSet(state.edges, JSON.stringify([edge.source, edge.target_id].sort()), edge, MAX_NOTES * 5);
      status.state = "ready"; status.candidates = candidates.length; status.truncated = notes.some(n => `${n.title}\n${n.content ?? ""}`.length > 6000);
    } catch (error) {
      if (current()) { status.state = "error"; status.reason = error.message === "invalid_embeddings" ? "invalid_embeddings" : "inference_unavailable"; }
    }
  }
  async wait(scope, id) {
    const state = this.state(scope);
    const jobs = id ? [state.jobs.get(id)].filter(Boolean) : [...state.jobs.values()];
    if (!jobs.length) return;
    let timer;
    try { await Promise.race([Promise.all(jobs.map(j => j.done.promise)), new Promise(resolve => { timer = setTimeout(resolve, 7000); })]); }
    finally { clearTimeout(timer); }
  }
  acceptCloud(scope,approved,vectors,consent) {
    // SQLite 판은 숫자, PG xmin은 문자열이다. 로컬 캐시와 같은 원본 타입을 유지한다.
    const inputs=approved.inputs.map(n=>({...n,version:JSON.parse(scope)[0]==='sqlite'?Number(n.version):n.version}));
    const state=this.state(scope),source=inputs[0],scope_versions=inputs.map(n=>({id:n.id,version:n.version}));
    this.invalidate(scope,source.id,source.version);
    for(const n of scope_versions)boundedSet(state.versions,n.id,n.version);
    const matches=[];
    inputs.slice(1).forEach((target,index)=>{
      const score=Math.max(-1,Math.min(1,vectors[0].reduce((sum,v,i)=>sum+v*vectors[index+1][i],0)));
      if(score>=THRESHOLD)matches.push({source:source.id,target_id:target.id,target_title:target.title,kind:'ai_similarity',score,
        provenance:{provider:'openrouter',model:approved.model,method:'embedding_cosine',source_version:source.version,target_version:target.version,analyzed_at:new Date().toISOString(),scope_versions,consent}});
    });
    for(const edge of matches.sort((a,b)=>b.score-a.score).slice(0,5))boundedSet(state.edges,JSON.stringify([edge.source,edge.target_id].sort()),edge,MAX_NOTES*5);
    const status={state:'ready',version:source.version,model:approved.model,local_only:false,candidates:approved.inputs.length-1,scope_versions,consent};
    boundedSet(state.statuses,source.id,status);return status;
  }
  graph(scope, notes) {
    const state = this.state(scope), known = new Map(notes.map(n => [n.id, n]));
    const valid=versions=>!versions || versions.every(n=>String(known.get(n.id)?.version)===String(n.version));
    for(const [id,status] of state.statuses)if(!valid(status.scope_versions))state.statuses.delete(id);
    const edges = [...state.edges.values()].filter(e => String(known.get(e.source)?.version) === String(e.provenance.source_version) && String(known.get(e.target_id)?.version) === String(e.provenance.target_version) && valid(e.provenance.scope_versions));
    return { edges, analysis: notes.map(note => ({ id: note.id, ...this.status(scope, note) })) };
  }
}
export const vaultSemantic = new VaultSemanticService();
