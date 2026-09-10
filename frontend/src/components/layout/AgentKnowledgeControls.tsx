import { useEffect, useRef, useState } from "react";
import type { KnowledgeConsentPreview, KnowledgeSave } from "../../services/agent-knowledge";
import { Button } from "../ui/Button";
import type { useAgentKnowledge } from "./useAgentKnowledge";

export function AgentAttachments({ knowledge, disabled }: Readonly<{ knowledge: ReturnType<typeof useAgentKnowledge>; disabled: boolean }>) {
  return <section className="agent-attachments" aria-label="대화 문서">
    <label>대화 문서 첨부<input type="file" aria-label="대화 문서 첨부" accept=".txt,.md,.pdf,.docx" disabled={disabled || knowledge.busy}
      onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void knowledge.upload(file); }} /></label>
    <small>최대 1MB · TXT, Markdown, 텍스트 PDF, DOCX · 이미지/OCR 미지원</small>
    {knowledge.attachments.length > 0 && <ul>{knowledge.attachments.map(item => <li key={item.id}>
      <span><b>{item.filename}</b><small>{item.knowledge_mode === "personal" ? "개인" : "회사"} · 추출 {item.text_length.toLocaleString()}자 · {item.size.toLocaleString()}바이트</small></span>
      <Button size="small" tone="neutral" disabled={disabled || knowledge.busy} aria-label={`${item.filename} 첨부 제거`} onClick={() => void knowledge.remove(item.id)}>제거</Button>
    </li>)}</ul>}
    {knowledge.busy && <p role="status">문서와 전송 범위를 확인하는 중입니다...</p>}
    {knowledge.error && <p role="alert">{knowledge.error}</p>}
  </section>;
}

export function AgentKnowledgeConsent({ preview, busy, onApprove, onCancel }: Readonly<{
  preview: KnowledgeConsentPreview; busy: boolean; onApprove: () => void; onCancel: () => void;
}>) {
  const [confirmed, setConfirmed] = useState(false);
  const element = useRef<HTMLElement>(null);
  useEffect(() => { element.current?.focus(); element.current?.scrollIntoView({ block: "nearest" }); }, []);
  return <section ref={element} tabIndex={-1} className="agent-action" aria-label="대화 자료 외부 전송 확인" data-consent-hash={preview.scope_hash}>
    <h3>개인 자료 외부 전송 확인</h3>
    <p>{preview.provider} · {preview.model}</p>
    <p>아래 범위만 이번 요청에 전송합니다. 지식 범위 선택과 외부 전송 동의는 별개입니다. 유용한 내용은 개인 노트로 정리합니다.</p>
    <p>만료: <time dateTime={preview.expires_at}>{preview.expires_at}</time></p>
    <ul className="agent-consent-sources">{preview.sources.map((source, index) => <li key={index}>
      <b>{source.title}</b><small>{source.kind} · 판 {source.version}</small><code>{source.id}</code><code>{source.content_hash}</code>
    </li>)}</ul>
    <details><summary>정확한 전송 범위</summary><pre>{JSON.stringify(preview, null, 2)}</pre></details>
    <label className="agent-action__check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />이 자료 범위의 외부 전송에 동의합니다</label>
    <Button disabled={busy || !confirmed} onClick={onApprove}>동의한 범위로 대화 전송</Button>
    <Button tone="neutral" disabled={busy} onClick={onCancel}>전송 승인 취소</Button>
  </section>;
}

export function AgentKnowledgeReceipts({ saves }: Readonly<{ saves: readonly KnowledgeSave[] }>) {
  return <ul className="agent-knowledge-receipts">{saves.map((save, index) => <li key={index} data-knowledge-save={save.status}>
    <b>{save.status === "saved" ? "지식 저장됨" : save.status === "failed" ? "지식 저장 실패" : "지식 저장 생략"}</b>
    <span>{save.scope === "personal" ? "개인" : "회사"} · AI 정리 · 검토 전</span>
    {save.link && /^\/(?:vault|documents)(?:[/?#]|$)/.test(save.link) ? <a href={save.link}>{save.title ?? "저장한 지식 열기"}</a> : save.title && <span>{save.title}</span>}
    {save.code && <small>{save.code}</small>}
  </li>)}</ul>;
}
