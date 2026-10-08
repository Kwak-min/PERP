import { createServer } from "node:http";

export const calls = [];
export const operations = new Map();
export const attachmentIds = { personal: "11111111-1111-4111-8111-111111111111", company: "22222222-2222-4222-8222-222222222222" };
export const consentToken = "33333333-3333-4333-8333-333333333333";
export const protectedResult = { tool_call_id: "protected-call", tool: "get.project_money", status: "protected", classification: "confidential", truncated: false,
  result: { amount: "1234567890.1234", currency: "KRW", title: "UI_ONLY_PRIVATE_SENTINEL" }, evidence: [{ source: "finance", id: "evidence-private" }] };
const attachments = new Map();
export const releaseHeld = Promise.withResolvers();
let chatFailures = 0, retryExecution = 0;
export const fixture = createServer(async (req, res) => {
  let text = "";
  for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : null;
  const url = new URL(req.url, "http://127.0.0.1");
  const requestPath = url.pathname;
  calls.push({ path: requestPath, query: Object.fromEntries(url.searchParams), method: req.method, body, key: req.headers["idempotency-key"], org: req.headers["x-org-id"] });
  const respond = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  if (requestPath.endsWith("/attachments") && req.method === "POST") {
    if (!["text/plain", "text/markdown", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"].includes(body.mime)) {
      return respond({ error: { code: "UNSUPPORTED_DOCUMENT", message: "지원하지 않는 문서 형식입니다.", details: {}, request_id: "" } }, 415);
    }
    const mode = body.knowledge_mode, bytes = Buffer.from(body.content_base64, "base64");
    if (bytes.toString() === "NO_TEXT") return respond({ error: { code: "DOCUMENT_NO_TEXT", message: "추출할 텍스트가 없습니다.", details: {}, request_id: "" } }, 422);
    const item = { id: attachmentIds[mode], filename: body.filename, mime: body.mime, size: bytes.length,
      knowledge_mode: mode, classification: mode === "personal" ? "personal" : "internal", text_length: bytes.toString().length,
      content_hash: `hash-${mode}`, download_url: `${requestPath}/${attachmentIds[mode]}/download?knowledge_mode=${mode}` };
    attachments.set(item.id, item);
    return respond(item, 201);
  }
  if (requestPath.includes("/attachments/") && req.method === "DELETE") {
    attachments.delete(requestPath.split("/").at(-1)); return respond({ deleted: true });
  }
  if (requestPath.endsWith("/knowledge/consent-preview")) return respond({
    token: consentToken, expires_at: "2099-01-01T00:00:00.000Z", scope_hash: "exact-personal-source-hash",
    provider: "openrouter", model: "fixture-model", knowledge_mode: "personal",
    sources: (body.attachment_ids ?? []).map(id => ({ id, kind: "attachment", title: attachments.get(id).filename, version: "1", content_hash: attachments.get(id).content_hash })),
  });
  if (requestPath.endsWith("/chat")) {
    if (body.message === "이전 범위") { fixture.emit("held"); await releaseHeld.promise; }
    if (body.message === "재시도" && chatFailures++ === 0) return respond({ error: { code: "TEMPORARY", message: "실패", details: {}, request_id: "" } }, 503);
    if (body.knowledge_mode === "personal" && body.attachment_ids?.length && !body.cloud_consent) {
      return respond({ error: { code: "PERSONAL_CLOUD_CONSENT_REQUIRED", message: "개인 자료 외부 전송 동의가 필요합니다.", details: {}, request_id: "" } }, 403);
    }
    const actions = ["문장만", "보호 조회"].includes(body.message) || body.attachment_ids?.length ? [] : [makeOperation(body.message)];
    actions.forEach(action => operations.set(action.id, action));
    const saveState = body.message === "저장 실패" ? "failed" : body.message === "저장 생략" ? "skipped" : "saved";
    return respond({ conversation_id: "conversation-1", run_id: "run-1",
      answer: { conclusion: "자료를 확인했습니다. 작업은 검토 후 실행하세요.", evidence: [], related_data: { vault_notes_used: 0 } },
      scope: { vault_mode: "off", personal_vault_used: false },
      protected_results: body.message === "보호 조회" ? [protectedResult] : [],
      tool_activity: [{ tool_call_id: "query-1", tool: "search.tasks", stage: "query", status: "completed", summary: "업무 원본 1건 확인" }], actions,
      knowledge_saves: body.attachment_ids?.length ? [{ status: saveState, scope: body.message === "범위 오류" ? "personal" : body.knowledge_mode, id: `saved-${body.knowledge_mode}`,
        title: body.message === "범위 오류" ? "FOREIGN_PERSONAL_SAVE" : "문서 결정 사항",
        ...(saveState === "saved" ? { link: `/${body.knowledge_mode === "personal" ? "vault" : "documents"}/saved-${body.knowledge_mode}` } : { code: "FIXTURE_SAVE_STATUS" }),
        ai_generated: true, review_status: "unreviewed" }] : [] });
  }
  if (requestPath.endsWith("/pending-approvals")) return respond({ items: [{ id: "approval-1", title: "고위험 결재", status: "pending", version: 1, requires_reauth: false, confirm_self_decision: true, blocked: false }] });
  if (requestPath.endsWith("/approvals/requests/approval-1/actions")) {
    const view = operations.get("고위험");
    view.approval_status = body.decision === "approve" ? "approved" : "rejected";
    view.can_execute = body.decision === "approve";
    return respond({ id: "approval-1" });
  }
  if (requestPath.endsWith("/approvers")) return respond({ items: [{ id: "approver-1", name: "검토 담당자", email: null }] });
  if (requestPath.includes("/operations/")) {
    const [encodedId, action] = requestPath.split("/operations/")[1].split("/");
    const id = decodeURIComponent(encodedId);
    const view = operations.get(id);
    if (!view) return respond({ error: { code: "NOT_FOUND", message: "접근할 수 없습니다.", details: {}, request_id: "" } }, 404);
    if (req.method === "GET") return respond(view);
    if (body.expected_version !== view.version) return respond({ error: { code: "CONFLICT", message: "버전 충돌", details: {}, request_id: "" } }, 409);
    if (action === "confirm") {
      view.status = "confirmed"; view.can_confirm = false; view.can_execute = !view.requires_approval;
      if (view.requires_approval) { view.approval_id = "approval-1"; view.approval_status = "pending"; }
    }
    if (action === "cancel") { view.status = "cancelled"; view.can_confirm = false; view.can_execute = false; view.can_cancel = false; }
    if (action === "execute") {
      if (id === "실행 재시도" && retryExecution++ === 0) return respond({ error: { code: "TEMPORARY", message: "전송 실패", details: {}, request_id: "" } }, 503);
      view.status = "executed"; view.can_execute = false; view.can_cancel = false; view.result = { id: "created-1", title: "실제 결과" };
      view.version += 1;
      if (id === "유실") return respond({ error: { code: "TEMPORARY", message: "실행 응답 유실", details: {}, request_id: "" } }, 503);
      return respond(view);
    }
    view.version += 1;
    return respond(view);
  }
  return respond({ items: [] });
});
function makeOperation(id) {
  const high = id === "고위험";
  return { id, tool: high ? "confirm.transaction" : "create.task", version: 1, status: "preview",
    preview: { title: id, fields: [{ label: "제목", value: "사용자가 검토할 실제 업무" }], warnings: high ? ["결재와 재인증이 필요합니다."] : [] },
    requires_confirmation: true, requires_approval: high, requires_reauth: high,
    approval_id: null, approval_status: null, can_confirm: true, can_execute: false, can_cancel: true, result: null };
}
