import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { Empty, PageHead, Pill, Tabs, won } from "./mockup/lib";
import { useApi } from "./mockup/useApi";

type Approval = {
  id: string;
  title: string;
  form_key: string;
  requester_id: string | null;
  amount: number;
  status: string;
  current_step: number;
  requires_reauth: boolean;
};
type Member = { user_id: string; name: string };

const AP_TONE: Record<string, string> = {
  pending: "warn",
  approved: "ok",
  rejected: "bad",
  withdrawn: "muted",
};
const AP_LABEL: Record<string, string> = {
  pending: "진행 중",
  approved: "승인",
  rejected: "반려",
  withdrawn: "회수",
};
const KIND_LABEL: Record<string, string> = {
  expense: "지출결의",
  settlement: "정산",
  leave: "휴가·불참",
  reopen: "회계기간 재오픈",
  agent: "AI 고위험 실행",
  generic: "결재",
};

// APR-001 승인함 — 실제 백엔드(/approvals/requests) 연동
export function ApprovalsScreen() {
  const [tab, setTab] = useState("inbox");
  const res = useApi<{ items: Approval[] }>(`/approvals/requests?box=${tab}`);
  const inboxRes = useApi<{ items: Approval[] }>("/approvals/requests?box=inbox");
  const sentRes = useApi<{ items: Approval[] }>("/approvals/requests?box=sent");
  const memberRes = useApi<{ items: Member[] }>("/members");

  const memberName = useMemo(() => {
    const m = new Map((memberRes.data?.items ?? []).map((x) => [x.user_id, x.name]));
    return (id: string | null) => (id ? (m.get(id) ?? "-") : "-");
  }, [memberRes.data]);

  const list = res.data?.items ?? [];

  return (
    <>
      <PageHead
        title="승인함"
        id="APR-001"
        fr="SFR-020"
        desc="결재선 규칙에 따라 순서대로 결재합니다. 반려는 사유가 필수이고, 100만원 이상은 재인증 후 승인됩니다."
      />
      <Tabs
        items={[
          ["inbox", "받은 결재", inboxRes.data?.items?.length ?? 0],
          ["sent", "보낸 결재", sentRes.data?.items?.length ?? 0],
          ["cc", "결재선 참여"],
          ["done", "완료"],
        ]}
        cur={tab}
        onChange={setTab}
      />
      <div className="panel tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>종류</th>
              <th>제목</th>
              <th>요청자</th>
              <th className="num">금액</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            {res.loading ? (
              <tr>
                <td colSpan={5}>
                  <Empty title="불러오는 중…" icon="clock" />
                </td>
              </tr>
            ) : list.length ? (
              list.map((a) => (
                <tr key={a.id}>
                  <td className="nowrap">
                    <Pill tone={a.form_key === "agent" ? "ai" : "muted"}>
                      {KIND_LABEL[a.form_key] ?? "결재"}
                    </Pill>
                  </td>
                  <td>
                    <Link className="t-title" to={`/approvals/${a.id}`}>
                      {a.title}
                    </Link>
                    {a.requires_reauth && a.status === "pending" && (
                      <>
                        {" "}
                        <span className="pill warn">
                          <Icon name="lock" />
                          재인증
                        </span>
                      </>
                    )}
                  </td>
                  <td className="nowrap">{memberName(a.requester_id)}</td>
                  <td className="num">{a.amount ? won(a.amount) : "-"}</td>
                  <td>
                    <Pill tone={AP_TONE[a.status] ?? "muted"}>{AP_LABEL[a.status] ?? a.status}</Pill>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5}>
                  <Empty
                    title={tab === "inbox" ? "내 차례의 결재가 없습니다" : "결재가 없습니다"}
                    desc={
                      tab === "inbox" ? "다른 계정으로 전환해 결재를 요청해 보세요." : undefined
                    }
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
