const STORES = new Set(["legacy", "pg"]);
const KINDS = new Set(["note", "document", "space"]);

function opaqueValue(value) {
  if (!((typeof value === "string" && value.trim().length > 0)
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0))) {
    throw new TypeError("invalid opaque graph ID");
  }
  return String(value);
}

export function graphIdentity({ store, company = null, owner = null, kind, opaqueId }) {
  if (!STORES.has(store) || !KINDS.has(kind)) throw new TypeError("invalid graph identity");
  const identity = {
    store,
    company: company == null ? null : opaqueValue(company),
    owner: owner == null ? null : opaqueValue(owner),
    kind,
    opaque_id: opaqueValue(opaqueId),
  };
  if (!identity.opaque_id || (kind === "note" ? !identity.owner : !identity.company)) {
    throw new TypeError("incomplete graph identity");
  }
  if (store === "pg" && kind === "note" && identity.company !== null) {
    throw new TypeError("PG personal graph identity cannot contain a company");
  }
  return identity;
}

export function graphRendererId(identity) {
  return JSON.stringify([
    identity.store,
    identity.company,
    identity.owner,
    identity.kind,
    identity.opaque_id,
  ]);
}

export function graphNode(record, identity) {
  return { ...record, renderer_id: graphRendererId(identity), identity };
}

export function graphEdge(record, sourceIdentity, targetIdentity, { binding, resolution, reason } = {}) {
  const resolved = resolution === "resolved" && targetIdentity != null;
  return {
    ...record,
    target_id: resolved ? record.target_id : null,
    source_renderer_id: graphRendererId(sourceIdentity),
    target_renderer_id: resolved ? graphRendererId(targetIdentity) : null,
    binding,
    resolution: resolved ? "resolved" : resolution,
    ...(reason ? { resolution_reason: reason } : {}),
  };
}
