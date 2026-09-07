import { useState } from "react";

import { Button } from "../../components/ui/Button";
import { MarkdownView } from "./MarkdownView";
import type { NoteDraft } from "./model";

type Props = Readonly<{
  draft: NoteDraft;
  editingId: string | null;
  folders: readonly string[];
  busy: boolean;
  storage?: "legacy" | "pg";
  onChange: (patch: Partial<NoteDraft>) => void;
  onSave: () => void;
  onDelete: () => void;
  onReset: () => void;
}>;

const MARKDOWN_PLACEHOLDER = `# 이번 주 회고

- 잘된 것: 브랜치 권한 정리
- 아쉬운 것: 근태 자동화 지연

> 다음 주에는 [[개인 목표 2026]] 다시 확인`;

export function NoteEditor({
  draft,
  editingId,
  folders,
  busy,
  storage = "legacy",
  onChange,
  onSave,
  onDelete,
  onReset,
}: Props) {
  const [mode, setMode] = useState<"write" | "preview">("write");

  return (
    <form
      className="note-editor"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <label>
        제목
        <input
          disabled={busy}
          value={draft.title}
          onChange={(event) => onChange({ title: event.target.value })}
          placeholder="예: 2026년 개인 목표"
          required
        />
      </label>
      <div className="note-editor__meta">
        <label>
          폴더
          <input
            disabled={busy}
            value={draft.folder}
            onChange={(event) => onChange({ folder: event.target.value })}
            placeholder="/"
            list="note-folders"
          />
          <datalist id="note-folders">
            {folders.map((folder) => (
              <option key={folder} value={folder} />
            ))}
          </datalist>
        </label>
        {storage !== "pg" && <label>
          태그 (쉼표로 구분)
          <input
            disabled={busy}
            value={draft.tags}
            onChange={(event) => onChange({ tags: event.target.value })}
            placeholder="예: 목표, 회고"
          />
        </label>}
      </div>
      <div className="note-editor__content">
        <div className="note-editor__tabs" role="tablist" aria-label="본문 편집 모드">
          <span className="note-editor__tabs-title">내용 (마크다운)</span>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "write"}
            className={mode === "write" ? "note-editor__tab note-editor__tab--on" : "note-editor__tab"}
            onClick={() => setMode("write")}
          >
            편집
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "preview"}
            className={mode === "preview" ? "note-editor__tab note-editor__tab--on" : "note-editor__tab"}
            onClick={() => setMode("preview")}
          >
            미리보기
          </button>
        </div>
        {mode === "write" ? (
          <textarea
            aria-label="본문 마크다운"
            className="note-editor__markdown"
            disabled={busy}
            value={draft.content}
            onChange={(event) => onChange({ content: event.target.value })}
            rows={14}
            placeholder={MARKDOWN_PLACEHOLDER}
            spellCheck={false}
          />
        ) : (
          <div className="note-editor__preview">
            <MarkdownView source={draft.content} />
          </div>
        )}
        <p className="note-editor__cheatsheet">
          <code># 제목</code> <code>**굵게**</code> <code>*기울임*</code> <code>`코드`</code>{" "}
          <code>- 목록</code> <code>1. 순서</code> <code>&gt; 인용</code> <code>```코드블록```</code>{" "}
          <code>[링크](url)</code> <code>[[다른 노트]]</code>
        </p>
      </div>
      {storage !== "pg" && <div className="note-editor__toggles">
        <label>
          <input
            type="checkbox"
            disabled={busy}
            checked={draft.pinned}
            onChange={(event) => onChange({ pinned: event.target.checked })}
          />
          <span>목록 상단에 고정</span>
        </label>
        <label>
          <input
            type="checkbox"
            disabled={busy}
            checked={draft.agent_enabled}
            onChange={(event) => onChange({ agent_enabled: event.target.checked })}
          />
          <span>AI Agent가 이 노트를 참고해도 됨</span>
        </label>
      </div>}
      <p className="note-editor__note">
        개인 노트는 소유자 본인만 볼 수 있습니다.{" "}
        {storage === "pg"
          ? "이 저장소는 제목·폴더·본문 저장을 지원합니다."
          : "비밀번호·API 키·주민등록번호 같은 자격증명은 저장이 거부됩니다."}
      </p>
      <div className="note-editor__actions">
        {editingId && (
          <Button tone="danger" size="small" disabled={busy} onClick={onDelete}>
            삭제
          </Button>
        )}
        <Button tone="neutral" size="small" disabled={busy} onClick={onReset}>
          {editingId ? "새 노트로" : "비우기"}
        </Button>
        <Button type="submit" disabled={busy || draft.title.trim() === ""}>
          {busy ? "저장 중…" : editingId ? "변경 저장" : "노트 만들기"}
        </Button>
      </div>
    </form>
  );
}
