import { useState } from "react";
import { Link } from "react-router-dom";

import { Icon } from "../components/ui/Icon";
import { demoNotifs } from "./mockup/demo";
import { Empty, PageHead, Tabs } from "./mockup/lib";

const KIND_LABEL: Record<string, string> = { approval: "승인", task: "업무", system: "시스템" };
const KIND_TONE: Record<string, string> = { approval: "warn", task: "info", system: "muted" };

// NOT-001 알림 센터 — 목업 notifications 이식
export function NotificationsScreen() {
  const [tab, setTab] = useState("unread");
  const mine = demoNotifs;
  const list = mine.filter((n) =>
    tab === "all" ? true : tab === "unread" ? !n.read : n.kind === tab,
  );

  return (
    <>
      <PageHead
        title="알림 센터"
        id="NOT-001"
        fr="SFR-027"
        actions={
          <button type="button" className="btn">
            모두 읽음으로 표시
          </button>
        }
      />
      <div className="grid g-main">
        <section className="panel">
          <div className="panel-b" style={{ paddingBottom: 0 }}>
            <Tabs
              items={[
                ["unread", "읽지 않음", mine.filter((n) => !n.read).length],
                ["task", "업무"],
                ["approval", "승인"],
                ["system", "시스템"],
                ["all", "전체", mine.length],
              ]}
              cur={tab}
              onChange={setTab}
            />
          </div>
          <div className="list">
            {list.length ? (
              list.map((n) => (
                <div className="li" key={n.id}>
                  <span className={`pill ${KIND_TONE[n.kind]}`}>{KIND_LABEL[n.kind]}</span>
                  <Link className="li-t" to={n.link ?? "/notifications"}>
                    <b
                      style={
                        n.read ? { fontWeight: 400, color: "var(--of-text-muted)" } : undefined
                      }
                    >
                      {n.text}
                    </b>
                    <small>
                      {n.at}
                      {n.read ? " · 읽음" : ""}
                    </small>
                  </Link>
                  {!n.read && (
                    <button type="button" className="btn btn-xs btn-ghost">
                      읽음
                    </button>
                  )}
                  <button type="button" className="btn btn-xs btn-ghost">
                    보관
                  </button>
                </div>
              ))
            ) : (
              <Empty
                title="표시할 알림이 없습니다"
                desc="새 결재·업무 멘션·시스템 알림이 여기에 모입니다."
              />
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-h">
            <h2>
              <Icon name="sliders" />
              구독 설정
            </h2>
          </div>
          <div className="panel-b stack">
            {[
              ["inapp", "앱 내 알림", "항상 켜짐 권장", true],
              ["email", "이메일", "결재·마감 알림만", false],
              ["discord", "Discord (#학생회-공지)", "연동 센터에서 연결됨", true],
            ].map(([k, l, h, on]) => (
              <label className="check" key={k as string}>
                <input type="checkbox" defaultChecked={on as boolean} />{" "}
                <span>
                  <b>{l}</b>
                  <br />
                  <span className="hint">{h}</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
