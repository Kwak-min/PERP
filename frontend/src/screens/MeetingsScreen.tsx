import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { demoMeetings } from "./mockup/demo";
import { Av, Empty, PageHead, fmtDate } from "./mockup/lib";

// DOC-003 회의록 — 목업 meetings 이식
export function MeetingsScreen() {
  const list = [...demoMeetings].sort((a, b) => b.date.localeCompare(a.date));
  return (
    <>
      <PageHead
        title="회의록"
        id="DOC-003"
        fr="SFR-018"
        desc="회의 메모에서 결정사항과 후속업무(담당·기한)를 추출해, 확인을 거쳐 업무로 만듭니다."
        actions={
          <button type="button" className="btn btn-primary">
            <Icon name="plus" />새 회의록
          </button>
        }
      />
      <div className="panel">
        <div className="list">
          {list.length ? (
            list.map((m) => (
              <Link className="li" to={`/documents/meetings/${m.id}`} key={m.id}>
                <span className="agenda-time">{fmtDate(m.date)}</span>
                <span className="li-t">
                  <b>{m.title}</b>
                  <small>
                    참석 {m.attendees.length}명 · 후속업무 {m.followups}건 생성
                    {m.project ? ` · ${m.project}` : ""}
                  </small>
                </span>
                <span className="av-stack">
                  {m.attendees.slice(0, 5).map((a) => (
                    <Av key={a} name={a} size="sm" />
                  ))}
                </span>
              </Link>
            ))
          ) : (
            <Empty title="회의록이 없습니다" desc="캘린더 일정에서 회의록을 바로 만들 수도 있습니다." />
          )}
        </div>
      </div>
    </>
  );
}
