import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { respondInvite } from "../services/reservationApi";
import "../screens/reservation.css";

export function InviteRespondPage() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<"idle" | "loading" | "accepted" | "declined" | "error">("idle");
  const [message, setMessage] = useState("");

  // URL 쿼리 파라미터로 자동 응답 지원 (?accept=true)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const autoAccept = params.get("accept");
    if (autoAccept !== null && token) {
      void handleRespond(autoAccept === "true");
    }
  }, [token]);

  const handleRespond = async (accept: boolean) => {
    if (!token) return;
    try {
      setStatus("loading");
      await respondInvite(token, accept);
      setStatus(accept ? "accepted" : "declined");
      setMessage(accept ? "참석을 수락했습니다." : "참석을 거절했습니다.");
    } catch (e: unknown) {
      setStatus("error");
      setMessage(e instanceof Error ? e.message : "처리 중 오류가 발생했습니다.");
    }
  };

  return (
    <div className="rsv-invite-page">
      <div className="rsv-invite-card">
        {status === "idle" && (
          <>
            <div className="rsv-invite-icon">📨</div>
            <h1 className="rsv-invite-title">회의 초대장</h1>
            <p className="rsv-invite-desc">
              회의에 초대되었습니다.<br />참석 여부를 선택해주세요.
            </p>
            <div className="rsv-invite-actions">
              <button
                className="btn btn-ghost"
                style={{ minWidth: 120 }}
                onClick={() => void handleRespond(false)}
              >
                거절
              </button>
              <button
                className="btn btn-primary"
                style={{ minWidth: 120 }}
                onClick={() => void handleRespond(true)}
              >
                수락
              </button>
            </div>
          </>
        )}

        {status === "loading" && (
          <>
            <div className="rsv-invite-icon">⏳</div>
            <h1 className="rsv-invite-title">처리 중...</h1>
          </>
        )}

        {status === "accepted" && (
          <>
            <div className="rsv-invite-icon">✅</div>
            <h1 className="rsv-invite-title">수락 완료</h1>
            <p className="rsv-invite-desc">{message}</p>
          </>
        )}

        {status === "declined" && (
          <>
            <div className="rsv-invite-icon">❌</div>
            <h1 className="rsv-invite-title">거절 완료</h1>
            <p className="rsv-invite-desc">{message}</p>
          </>
        )}

        {status === "error" && (
          <>
            <div className="rsv-invite-icon">⚠️</div>
            <h1 className="rsv-invite-title">오류 발생</h1>
            <p className="rsv-invite-desc" style={{ color: "#f87171" }}>{message}</p>
            <div className="rsv-invite-actions">
              <button className="btn btn-primary" onClick={() => setStatus("idle")}>다시 시도</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
