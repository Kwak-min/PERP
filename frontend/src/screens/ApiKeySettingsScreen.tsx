import { useEffect, useState } from "react";
import { z } from "zod";

import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import type { ScreenDefinition } from "../routes/catalog";
import { apiRequest, userMessageOf } from "../services/api";
import { useSession } from "../store/session";
import type { SessionState } from "../store/session";
import "./api-key-settings.css";

const metadataSchema = z.object({
  provider: z.literal("openrouter"), configured: z.boolean(), model: z.string(),
  credential_mode: z.enum(["shared", "personal"]),
});
const connectionSchema = z.object({
  provider: z.literal("openrouter"), connected: z.literal(true), model: z.string(),
});
type LoadState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "ready"; metadata: z.infer<typeof metadataSchema> }>;
type Notice = Readonly<{ error: boolean; message: string }>;

export function ApiKeySettingsScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  if (!session) return <p role="alert">로그인 후 AI 연결 설정을 확인하세요.</p>;
  // 계정/조직 변경 시 입력값과 진행 중 화면 상태를 함께 폐기한다.
  return <KeySettings key={`${session.token}:${session.orgId}`} screen={screen} session={session} />;
}

function KeySettings({ screen, session }: Readonly<{ screen: ScreenDefinition; session: SessionState }>) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reload, setReload] = useState(0);
  const configured = state.kind === "ready" && state.metadata.configured;
  const shared = state.kind === "ready" && state.metadata.credential_mode === "shared";
  const orgName = session.organizations.find((org) => org.org_id === session.orgId)?.org_name ?? "현재 조직";

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    apiRequest("/pg/agent/api-key", { session, signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setState({ kind: "ready", metadata: metadataSchema.parse(data) });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setState({ kind: "error", message: userMessageOf(error) });
      });
    return () => controller.abort();
  }, [session, reload]);

  async function mutate(method: "PUT" | "DELETE"): Promise<void> {
    setBusy(true);
    setNotice(null);
    const body = method === "PUT" ? { api_key: apiKey } : undefined;
    setApiKey("");
    try {
      const data = await apiRequest("/pg/agent/api-key", { session, method, body });
      setState({ kind: "ready", metadata: metadataSchema.parse(data) });
      setConfirmDelete(false);
      setNotice({ error: false, message: method === "PUT" ? "개인 키를 저장했습니다. 연결 테스트로 사용 가능 여부를 확인하세요." : "개인 키를 삭제했습니다." });
    } catch (error: unknown) {
      setNotice({ error: true, message: userMessageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  async function testConnection(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const result = connectionSchema.parse(await apiRequest("/pg/agent/api-key/test", { session, method: "POST" }));
      setNotice({ error: false, message: `연결 성공: ${shared ? "서버 관리 공용 키" : "저장된 개인 키"}로 ${result.model} 응답을 확인했습니다.` });
    } catch (error: unknown) {
      setNotice({ error: true, message: userMessageOf(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen api-key-settings" data-screen-id={screen.id}>
      <header className="screen-header">
        <div>
          <div className="screen-header__meta"><span className="eyebrow">AI 연결 설정</span><Badge>OpenRouter</Badge></div>
          <h1>{screen.label}</h1>
          <p>{shared ? "모든 회사가 서버에서 관리하는 공용 OpenRouter 키를 사용합니다. 회사별 데이터와 사용자 권한은 공유되지 않습니다." : `${orgName}에서 ${session.name}님의 AI 연결 설정을 확인합니다.`}</p>
        </div>
      </header>
      {notice && <div className="screen-notice" role={notice.error ? "alert" : "status"}>{notice.message}</div>}
      <SectionCard title={shared ? "서버 관리 OpenRouter 연결" : "개인 OpenRouter 연결"} subtitle="OpenRouter에서 발급한 API 키만 지원합니다" padded>
        {state.kind === "loading" && <p role="status">저장 상태를 불러오는 중입니다.</p>}
        {state.kind === "error" && <div role="alert"><p>{state.message}</p><Button tone="neutral" onClick={() => setReload((value) => value + 1)}>다시 불러오기</Button></div>}
        {state.kind === "ready" && <>
          <div className="api-key-settings__summary">
            <output data-testid="api-key-status" data-configured={String(configured)} data-credential-mode={state.metadata.credential_mode}><Badge tone={configured ? "success" : "neutral"}>{shared ? "서버 관리 공용 키 사용 중" : configured ? "개인 키 등록됨" : "개인 키 미등록"}</Badge></output>
            <span>요청 모델: <strong>{state.metadata.model}</strong></span>
          </div>
          {shared ? <div data-testid="shared-key-settings">
            <p>개인 키를 입력하거나 저장할 필요가 없습니다. 기존 개인 키는 보존되며 공용 키를 대체하지 않습니다. 공용 키 변경은 서버 관리자에게 요청하세요.</p>
            <Button tone="neutral" disabled={busy || !configured} onClick={() => void testConnection()}>연결 테스트</Button>
          </div> : <form className="form-stack" onSubmit={(event) => { event.preventDefault(); void mutate("PUT"); }}>
            <label htmlFor="openrouter-api-key">OpenRouter API 키</label>
            <input id="openrouter-api-key" type="password" autoComplete="off" spellCheck={false} maxLength={4096} required value={apiKey}
              onChange={(event) => setApiKey(event.target.value)} disabled={busy} aria-describedby="api-key-help" placeholder={configured ? "교체할 새 키를 입력하세요" : "발급받은 키를 입력하세요"} />
            <p id="api-key-help">키는 서버에서 암호화하여 보관하며 저장 후 다시 표시하지 않습니다. 이 입력값은 브라우저 저장소에 보관하지 않습니다.</p>
            <div className="api-key-settings__actions">
              <Button type="submit" disabled={busy || !apiKey.trim()}>{configured ? "키 교체" : "키 저장"}</Button>
              <Button tone="neutral" disabled={busy || !configured} onClick={() => void testConnection()}>연결 테스트</Button>
              <Button tone="danger" disabled={busy || !configured} onClick={() => setConfirmDelete(true)}>키 삭제</Button>
            </div>
          </form>}
          {busy && <p role="status">요청을 처리하고 있습니다.</p>}
          {!shared && confirmDelete && <div className="api-key-settings__confirmation" role="group" aria-label="개인 키 삭제 확인">
            <p>이 조직에서 사용하는 내 개인 키를 삭제할까요?</p>
            <div className="api-key-settings__actions"><Button tone="danger" disabled={busy} onClick={() => void mutate("DELETE")}>삭제 확인</Button><Button tone="neutral" disabled={busy} onClick={() => setConfirmDelete(false)}>취소</Button></div>
          </div>}
        </>}
      </SectionCard>
      <SectionCard title="전송 범위와 비용" padded>
        <ul className="api-key-settings__policy">
          <li>연결 테스트는 짧은 테스트 문장만 전송합니다. 문서, AI 기억, 개인 노트는 포함하지 않으며 소액의 API 비용이 발생할 수 있습니다.</li>
          <li>키 설정은 개인 노트의 외부 전송 동의가 아닙니다. 민감·기밀 데이터와 로컬 전용 정책은 공용 키가 있어도 로컬 모델만 사용합니다.</li>
          <li>서버 관리 공용 키가 설정되면 허용된 외부 AI 요청에서 개인 키보다 우선합니다. 공용 키 값은 브라우저에 표시하거나 저장하지 않습니다.</li>
          <li>대화 패널은 개인 Vault 제외 계약 정비 전까지 비활성 상태입니다. 이 화면에서는 키 관리와 연결 테스트를 사용할 수 있습니다.</li>
        </ul>
      </SectionCard>
    </div>
  );
}
