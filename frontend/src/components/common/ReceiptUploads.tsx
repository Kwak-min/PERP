import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { apiReceiptUpload, userMessageOf, type ApiSession } from '../../services/api';
import { financePath, uploadSchema, type Receipt, type UploadSlot } from '../../screens/expenses/model';
import { Button } from '../ui/Button';

type Props = Readonly<{ session: ApiSession; slots: readonly UploadSlot[]; setSlots: Dispatch<SetStateAction<UploadSlot[]>>; locked: boolean; existing?: readonly Receipt[] }>;
export function ReceiptUploads({ session, slots, setSlots, locked, existing = [] }: Props) {
  const scope = useRef(new AbortController());
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const controller = new AbortController(); scope.current = controller; return () => controller.abort(); }, []);
  async function upload(slot: UploadSlot) {
    const controller = scope.current;
    setSlots(current => current.map(item => item.id === slot.id ? { id: item.id, file: item.file, state: 'pending' } : item));
    try {
      const uploaded = uploadSchema.parse(await apiReceiptUpload(`${financePath(session.orgId)}/transactions/receipt-uploads`, { file: slot.file, session, signal: controller.signal }));
      if (!controller.signal.aborted) setSlots(current => current.map(item => item.id === slot.id ? { ...item, state: 'ready', upload: uploaded } : item));
    } catch (caught: unknown) {
      if (!controller.signal.aborted) setSlots(current => current.map(item => item.id === slot.id ? { ...item, state: 'failed', error: userMessageOf(caught) } : item));
    }
  }
  function select(files: readonly File[]) {
    setError(null);
    if (slots.length + existing.length + files.length > 5 || [...slots.map(slot => slot.file.size), ...existing.map(file => file.size_bytes), ...files.map(file => file.size)].reduce((sum, size) => sum + size, 0) > 25 * 1024 * 1024) {
      setError('영수증은 최대 5개, 합계 25MiB까지 첨부할 수 있습니다.'); return;
    }
    if (files.some(file => file.size > 10 * 1024 * 1024 || !['image/jpeg', 'image/png', 'application/pdf'].includes(file.type) || !/\.(?:jpe?g|png|pdf)$/i.test(file.name))) {
      setError('JPEG·PNG·PDF 파일만 가능하며 파일당 10MiB 이하여야 합니다.'); return;
    }
    const next: UploadSlot[] = files.map(file => ({ id: crypto.randomUUID(), file, state: 'pending' }));
    setSlots(current => [...current, ...next]);
    for (const slot of next) void upload(slot);
  }
  return <fieldset className="expense-receipts" disabled={locked}>
    <legend>영수증</legend>
    <p>JPEG·PNG·PDF · 파일당 10MiB · 최대 5개 / 합계 25MiB. 원본은 다운로드로만 제공합니다.</p>
    <label>영수증 파일<input type="file" name="receipts" accept="image/jpeg,image/png,application/pdf" multiple onChange={event => { select(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></label>
    {error && <p role="alert">{error}</p>}
    <ul>{slots.map(slot => <li key={slot.id} data-upload-state={slot.state}>
      <span>{slot.file.name} · {slot.file.size.toLocaleString()} bytes</span>
      <span role="status">{slot.state === 'pending' ? '업로드 중' : slot.state === 'ready' ? '첨부 준비 완료' : '업로드 실패'}</span>
      {slot.error && <p role="alert">{slot.error}</p>}
      {slot.state === 'failed' && <Button tone="neutral" onClick={() => void upload(slot)}>업로드 재시도</Button>}
      <Button tone="ghost" onClick={() => setSlots(current => current.filter(item => item.id !== slot.id))}>제거</Button>
    </li>)}</ul>
  </fieldset>;
}
