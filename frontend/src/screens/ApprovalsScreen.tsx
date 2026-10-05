import { useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import {
  AP_LABEL,
  AP_TONE,
  APPROVAL_KINDS,
  demoApprovals,
  type DemoApproval,
} from "./mockup/demo";
import { Empty, PageHead, Pill, Tabs, won } from "./mockup/lib";

// APR-001 승인함 — 목업 approvalsView() 이식
export function ApprovalsScreen() {
  const [tab, setTab] = useState("inbox");
  const box = (b: DemoApproval["box"]) => demoApprovals.filter((a) => a.box === b);
  const sets = {
    inbox: box("inbox"),
    sent: box("sent"),
    cc: box("cc"),
    done: box("done"),
  };
  const list = sets[tab as keyof typeof sets] ?? [];

  return (
    <>
      <PageHead
        title="승인함"
        id="APR-001"
        fr="SFR-020"
        desc="결재선 규칙에 따라 순서대로 결재합니다. 반려는 사유가 필수이고, 100만원 이상은 재인증 후 승인됩니다. 종결된 결재는 수정할 수 없습니다."
      />
      <Tabs
        items={[
          ["inbox", "받은 결재", sets.inbox.length],
          ["sent", "보낸 결재", sets.sent.length],
          ["cc", "결재선 참여", sets.cc.length],
          ["done", "완료", sets.done.length],
        ]}
        cur={tab}
        onChange={setTab}
      />
      <div className="panel tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              {tab === "inbox" && <th style={{ width: 36 }} />}
              <th>종류</th>
              <th>제목</th>
              <th>요청자</th>
              <th className="num">금액</th>
              <th>현재 단계</th>
              <th>상태</th>
              <th>요청일</th>
            </tr>
          </thead>
          <tbody>
            {list.length ? (
              list.map((a) => (
                <tr key={a.id}>
                  {tab === "inbox" && (
                    <td>
                      <input type="checkbox" aria-label="선택" />
                    </td>
                  )}
                  <td className="nowrap">
                    <Pill tone={a.kind === "agent" ? "ai" : "muted"}>{APPROVAL_KINDS[a.kind]}</Pill>
                  </td>
                  <td>
                    <Link className="t-title" to={`/approvals/${a.id}`}>
                      {a.title}
                    </Link>
                    {a.reauth && a.status === "pending" && (
                      <>
                        {" "}
                        <span className="pill warn">
                          <Icon name="lock" />
                          재인증
                        </span>
                      </>
                    )}
                  </td>
                  <td className="nowrap">{a.requester}</td>
                  <td className="num">{a.amount ? won(a.amount) : "-"}</td>
                  <td className="nowrap">{a.step}</td>
                  <td>
                    <Pill tone={AP_TONE[a.status]}>{AP_LABEL[a.status]}</Pill>
                  </td>
                  <td className="nowrap muted">{a.createdAt}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={8}>
                  <Empty
                    title={tab === "inbox" ? "내 차례의 결재가 없습니다" : "결재가 없습니다"}
                    desc={tab === "inbox" ? "다른 계정으로 전환해 결재를 요청해 보세요." : undefined}
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
