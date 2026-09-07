import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";
import { NoteEditor } from "./vault/NoteEditor";
import {
  EMPTY_DRAFT,
  draftOf,
  noteDetailSchema,
  noteListSchema,
  tagsOf,
  type Note,
  type NoteDraft,
} from "./vault/model";

import "./vault.css";

export function VaultScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const [notes, setNotes] = useState<readonly Note[]>([]);
  const [folders, setFolders] = useState<readonly string[]>([]);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const openRequest = useRef<AbortController | null>(null);

  const apiSession = useMemo(
    () => (session?.orgId ? { token: session.token, orgId: session.orgId } : null),
    [session?.token, session?.orgId],
  );

  const reload = useCallback(async (): Promise<void> => {
    if (!apiSession) return;
    try {
      const data = noteListSchema.parse(await apiRequest("/pg/vault/notes?limit=100", { session: apiSession }));
      setNotes(data.items);
      setFolders(data.folders);
      setError(null);
    } catch (caught) {
      setError(userMessageOf(caught));
    }
  }, [apiSession]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const sorted = [...notes].sort((a, b) => Number(b.pinned) - Number(a.pinned));
    if (!needle) return sorted;
    return sorted.filter(
      (note) =>
        note.title.toLowerCase().includes(needle) ||
        note.tags.some((tag) => tag.toLowerCase().includes(needle)) ||
        note.folder.toLowerCase().includes(needle),
    );
  }, [notes, query]);

  async function open(noteId: string): Promise<void> {
    if (!apiSession) return;
    openRequest.current?.abort();
    const controller = new AbortController();
    openRequest.current = controller;
    setBusy(true);
    setError(null);
    try {
      const detail = noteDetailSchema.parse(
        await apiRequest(`/pg/vault/notes/${noteId}`, { session: apiSession, signal: controller.signal }),
      );
      if (controller.signal.aborted) return;
      setEditingId(detail.id);
      setDraft(draftOf(detail));
    } catch (caught) {
      if (!controller.signal.aborted) setError(userMessageOf(caught));
    } finally {
      if (openRequest.current === controller) {
        openRequest.current = null;
        setBusy(false);
      }
    }
  }

  async function save(): Promise<void> {
    if (!apiSession || draft.title.trim() === "") return;
    setBusy(true);
    setError(null);
    const body = {
      title: draft.title.trim(),
      content: draft.content,
      folder: draft.folder.trim() || "/",
      tags: tagsOf(draft),
      pinned: draft.pinned,
      agent_enabled: draft.agent_enabled,
    };
    try {
      if (editingId) {
        await apiRequest(`/pg/vault/notes/${editingId}`, { method: "PATCH", session: apiSession, body });
        setNotice(`${body.title} 노트를 저장했습니다.`);
      } else {
        const created = noteDetailSchema.parse(
          await apiRequest("/pg/vault/notes", { method: "POST", session: apiSession, body }),
        );
        setEditingId(created.id);
        setNotice(`${body.title} 노트를 만들었습니다.`);
      }
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!apiSession || !editingId) return;
    setBusy(true);
    setError(null);
    try {
      await apiRequest(`/pg/vault/notes/${editingId}`, { method: "DELETE", session: apiSession });
      setEditingId(null);
      setDraft(EMPTY_DRAFT);
      setNotice("노트를 삭제했습니다.");
      await reload();
    } catch (caught) {
      setError(userMessageOf(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta">
            <span className="eyebrow">개인</span>
            <Badge>{screen.id}</Badge>
            <Badge tone="neutral">본인 전용</Badge>
          </div>
          <h1>{screen.label}</h1>
          <p>{screen.description}</p>
        </div>
        <div className="screen-header__actions">
          <Button
            tone="neutral"
            size="small"
            onClick={() => {
              setEditingId(null);
              setDraft(EMPTY_DRAFT);
            }}
          >
            새 노트
          </Button>
        </div>
      </header>

      {error && <div className="form-error" role="alert">{error}</div>}
      {notice && (
        <div className="screen-notice" role="status">
          <span>{notice}</span>
          <Button tone="ghost" size="small" onClick={() => setNotice(null)}>닫기</Button>
        </div>
      )}

      <div className="vault-layout">
        <SectionCard
          padded
          title="내 노트"
          subtitle={`${notes.length}개`}
          foot="고정한 노트가 위에 옵니다"
        >
          <label className="vault-search">
            <span className="sr-only">노트 검색</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="제목·태그·폴더 검색"
            />
          </label>
          {visible.length === 0 ? (
            <p className="vault-empty">
              {notes.length === 0 ? "아직 노트가 없습니다. 오른쪽에서 첫 노트를 작성하세요." : "조건에 맞는 노트가 없습니다."}
            </p>
          ) : (
            <ul className="vault-list">
              {visible.map((note) => (
                <li key={note.id}>
                  <button
                    type="button"
                    className={note.id === editingId ? "vault-list__item vault-list__item--on" : "vault-list__item"}
                    onClick={() => void open(note.id)}
                  >
                    <b>
                      {note.pinned && <span aria-label="고정됨">📌 </span>}
                      {note.title}
                    </b>
                    <span>{note.folder}{note.tags.length > 0 ? ` · ${note.tags.join(", ")}` : ""}</span>
                    <small>{note.updated_at.slice(0, 10)}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard
          padded
          title={editingId ? "노트 편집" : "새 노트 작성"}
          subtitle={editingId ? "내용을 고치고 저장하세요" : "제목과 내용을 적으면 바로 저장됩니다"}
        >
          <NoteEditor
            draft={draft}
            editingId={editingId}
            folders={folders}
            busy={busy}
            onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
            onSave={() => void save()}
            onDelete={() => void remove()}
            onReset={() => {
              setEditingId(null);
              setDraft(EMPTY_DRAFT);
            }}
          />
        </SectionCard>
      </div>
    </div>
  );
}
