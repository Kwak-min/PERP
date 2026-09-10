import { useEffect, useRef, useState } from 'react';
import { createRequestKey } from '../../services/requestKey';
import { z } from 'zod';
import { ApiError, apiBlob, apiRequest, userMessageOf, type ApiSession } from '../../services/api';
import { Button } from '../../components/ui/Button';
import { isPgWorkspace } from '../../services/workspace';
import { ReceiptUploads } from '../../components/common/ReceiptUploads';
import { detailSchema, financePath, statusLabel, type Detail, type Receipt, type UploadSlot } from './model';

export function ExpenseDetail({ id, session, canWrite, onClose, onChanged }: Readonly<{ id: string; session: ApiSession; canWrite: boolean; onClose: () => void; onChanged: () => void }>) {
  const [detail, setDetail] = useState<(Detail & Readonly<{ receiptToken: string | number }>) | null>(null), [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null), [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false);
  const [slots, setSlots] = useState<UploadSlot[]>([]), [downloading, setDownloading] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const scope = useRef(new AbortController());
  const pending = useRef<{ key: string; body: { expected_version: string | number; receipt_tokens: string[] } } | null>(null);
  const base = `${financePath(session.orgId)}/transactions/${encodeURIComponent(id)}`;
  useEffect(() => { const controller = new AbortController(); scope.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController(); setDetail(null); setError(null);
    apiRequest(base, { session, signal: controller.signal }).then(payload => {
      const row = detailSchema.parse(payload);
      if (row.id !== id) throw new ApiError('다른 전표가 응답되었습니다.', { code: 'INVALID_RESPONSE', status: 502, requestId: '', details: {} });
      const receiptToken = isPgWorkspace(session.orgId) ? z.string().regex(/^\d+$/).parse(row.receipt_version) : row.version;
      if (!controller.signal.aborted) setDetail({ ...row, receiptToken });
    }).catch((caught: unknown) => { if (!controller.signal.aborted) setError(userMessageOf(caught)); });
    return () => controller.abort();
  }, [base, id, session, revision]);
  async function download(receipt: Receipt) {
    const controller = scope.current; setDownloading(receipt.file_id); setError(null);
    try {
      const received = await apiBlob(`${base}/receipts/${encodeURIComponent(receipt.file_id)}`, { session, signal: controller.signal });
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(received.blob);
      try { const anchor = document.createElement('a'); anchor.href = url; anchor.download = received.filename; anchor.click(); }
      finally { URL.revokeObjectURL(url); }
    } catch (caught: unknown) { if (!controller.signal.aborted) setError(userMessageOf(caught)); }
    finally { if (!controller.signal.aborted) setDownloading(null); }
  }
  async function append() {
    if (!detail || saving) return;
    if (!pending.current) {
      const tokens = slots.flatMap(slot => slot.upload ? [slot.upload.token] : []);
      if (!tokens.length || slots.some(slot => slot.state !== 'ready')) return;
      pending.current = { key: createRequestKey(), body: { expected_version: detail.receiptToken, receipt_tokens: tokens } };
    }
    const request = pending.current, controller = scope.current;
    setSaving(true); setError(null); setMessage(null);
    try {
      const result = z.object({ id: z.coerce.string() }).parse(await apiRequest(`${base}/receipts`, { session, signal: controller.signal, method: 'POST', headers: { 'Idempotency-Key': request.key }, body: request.body }));
      if (result.id !== id) throw new ApiError('다른 전표가 응답되었습니다.', { code: 'INVALID_RESPONSE', status: 502, requestId: '', details: {} });
      if (!controller.signal.aborted) { pending.current = null; setSlots([]); setUncertain(false); setMessage('영수증 추가가 감사 이력과 함께 저장되었습니다.'); setRevision(n => n + 1); onChanged(); }
    } catch (caught: unknown) {
      if (!controller.signal.aborted) {
        const definite = caught instanceof ApiError && caught.status >= 400 && caught.status < 500 && !['HTTP_ERROR', 'INVALID_RESPONSE'].includes(caught.code);
        if (definite) pending.current = null;
        setUncertain(!definite); setError(userMessageOf(caught));
      }
    } finally { if (!controller.signal.aborted) setSaving(false); }
  }
  return <section className="expense-panel" data-expense-detail={id} aria-label="거래 상세">
    <header><h2>거래 상세</h2><div className="expense-actions"><Button tone="neutral" disabled={saving || uncertain} onClick={() => setRevision(n => n + 1)}>상세 다시 불러오기</Button><Button tone="ghost" disabled={saving || uncertain} onClick={onClose}>상세 닫기</Button></div></header>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!detail && !error && <p role="status">장부와 영수증을 불러오는 중...</p>}
    {detail && <><dl className="expense-facts">
      <div><dt>전표 ID</dt><dd>{detail.id}</dd></div><div><dt>상태</dt><dd>{statusLabel(detail.status)}</dd></div>
      <div><dt>장부 금액</dt><dd data-detail-amount>{detail.amount ?? '금액 없음'} {detail.input_currency ?? detail.currency ?? ''}</dd></div>
      <div><dt>거래일</dt><dd>{detail.expense_date}</dd></div>
      <div><dt>상대방</dt><dd>{detail.counterparty ?? '기존 기록 · 상대방 정보 없음'}</dd></div>
      <div><dt>사용 시각 (서울)</dt><dd>{detail.occurred_at ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(detail.occurred_at)) : '시각 정보 없음'}</dd></div>
      <div><dt>계정 ID</dt><dd data-detail-account>{detail.account_id ?? '단일 계정 없음 · 아래 분개 확인'}</dd></div>
      <div><dt>예산 ID</dt><dd>{detail.budget_id ?? '없음'}</dd></div>
      <div><dt>메모</dt><dd>{detail.memo || '없음'}</dd></div><div><dt>생성 당시 미첨부 사유</dt><dd>{detail.no_receipt_reason ?? '기록 없음'}</dd></div>
    </dl>
    {detail.input_currency === null && <p data-old-record>기존 기록입니다. 새 지출 입력 정보를 추측하지 않습니다.</p>}
    {detail.lines && <details><summary>회계 상세 (원본 분개)</summary><div className="expense-table-wrap"><table><caption>실제 장부 분개</caption><thead><tr><th>계정 ID</th><th>계정 유형</th><th>차변</th><th>대변</th></tr></thead><tbody>{detail.lines.map(line => <tr key={line.id}><td>{line.account_id}</td><td>{line.account_type}</td><td>{line.debit}</td><td>{line.credit}</td></tr>)}</tbody></table></div></details>}
    <h3>원본 영수증 ({detail.receipts.length})</h3><ul className="expense-files">{detail.receipts.map(file => <li key={file.file_id}><span>{file.filename} · {file.mime} · {file.size_bytes.toLocaleString()} bytes</span><Button tone="neutral" data-receipt-download={file.file_id} disabled={downloading !== null} onClick={() => void download(file)}>{downloading === file.file_id ? '다운로드 중...' : '원본 다운로드'}</Button></li>)}</ul>
    {!detail.receipts.length && <p>첨부된 원본이 없습니다.</p>}
    <p>확정된 금액·내용은 덮어쓰지 않습니다. 사후 영수증 추가는 원본을 보존하며 감사 이력을 남깁니다.</p>
    {canWrite && <><ReceiptUploads session={session} slots={slots} setSlots={setSlots} existing={detail.receipts} locked={saving || uncertain} />
      {uncertain && <p role="status">응답 미확인: 같은 요청 키로 추가 결과를 확인합니다.</p>}
      <Button data-append-receipts disabled={saving || !slots.length || slots.some(slot => slot.state !== 'ready')} onClick={() => void append()}>{saving ? '추가 저장 중...' : uncertain ? '같은 첨부 요청 재시도' : '영수증 추가 저장'}</Button></>}
    </>}
  </section>;
}
