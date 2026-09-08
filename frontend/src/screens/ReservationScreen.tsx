import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { SectionCard } from "../components/ui/SectionCard";
import type { ScreenDefinition } from "../routes/catalog";
import { useSession } from "../store/session";
import { useAccess } from "../hooks/useWorkspaceAccess";
import {
  addWaitlist,
  cancelReservation,
  cancelWaitlist,
  createReservation,
  createSpace,
  createTestSpaces,
  deleteSpace,
  getMyReservations,
  getMyWaitlist,
  getSpaces,
  updateReservation,
  updateSpace,
  type SpaceFilter,
} from "../services/reservationApi";
import { AttendeePanel } from "./reservation/AttendeePanel";
import { CancelScopeModal } from "./reservation/CancelScopeModal";
import { SpaceMonthCalendar } from "./reservation/SpaceMonthCalendar";
import { seoulDay, type FreeInterval } from "./reservation/occupancy";

import {
  formatDate,
  formatDateRange,
  formatTime,
  formatRecurrenceRule,
  reservationSchema,
  spaceSchema,
  STATUS_LABEL,
  waitlistSchema,
  type CancelScope,
  type CreateReservationInput,
  type Reservation,
  type ReservationStatus,
  type Space,
  type UpdateReservationInput,
  type Waitlist,
} from "./reservation/model";
import { ReservationFormModal } from "./reservation/ReservationFormModal";
import { SpaceFormModal } from "./reservation/SpaceFormModal";

import "./reservation.css";

type MainTab = "spaces" | "my" | "waitlist" | "admin";

type TimetableModalState =
  | { type: "create"; slot: FreeInterval }
  | { type: "detail"; reservation: Reservation }
  | { type: "edit"; reservation: Reservation }
  | { type: "cancel"; reservation: Reservation };

type SpaceAdminModalState =
  | { type: "create" }
  | { type: "edit"; space: Space };

export function ReservationScreen({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  // 회사 전환 시 이전 회사의 목록/모달/진행 중 응답을 새 화면에 재사용하지 않는다.
  return <ReservationWorkspace key={`${session?.orgId}:${session?.token}`} screen={screen} />;
}

function ReservationWorkspace({ screen }: Readonly<{ screen: ScreenDefinition }>) {
  const session = useSession();
  const organization = session?.organizations.find((org) => org.org_id === session.orgId);
  const access = useAccess();
  const isAdmin = Boolean(
    access && access.org_id === session?.orgId && access.modules.includes("assets")
      && (access.permissions.includes("*") || access.permissions.includes("reservation.manage"))
  );

  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab");
  const activeTab: MainTab = tab === "admin" || tab === "my" || tab === "waitlist" ? tab : "spaces";
  const setActiveTab = (next: MainTab) => { setTimetableModal(null); setSearchParams({ tab: next }); };

  // ── Tab 1: 공간 검색 & 예약 상태 ──────────────────────────────────────
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spacesLoading, setSpacesLoading] = useState(true);
  const [spacesError, setSpacesError] = useState<string | null>(null);

  const todayStr = seoulDay();
  const [filterDate, setFilterDate] = useState(todayStr);
  const [minCapacity, setMinCapacity] = useState("");

  // 선택된 공간 타임테이블 뷰
  const [selectedSpaceId, setSelectedSpaceId] = useState<number | null>(null);
  const [selectedSpace, setSelectedSpace] = useState<Space | null>(null);
  const [timetableDate, setTimetableDate] = useState("");
  const [calendarRevision, setCalendarRevision] = useState(0);
  const spacesRequest = useRef<AbortController | null>(null);
  const [timetableModal, setTimetableModal] = useState<TimetableModalState | null>(null);
  const [timetableBusy, setTimetableBusy] = useState(false);

  // ── Tab 2: 내 예약 상태 ────────────────────────────────────────────────
  const [myReservations, setMyReservations] = useState<Reservation[]>([]);
  const [myLoading, setMyLoading] = useState(false);
  const [myError, setMyError] = useState<string | null>(null);
  const [myStatusTab, setMyStatusTab] = useState<ReservationStatus | "ALL">("CONFIRMED");
  const [myDetailId, setMyDetailId] = useState<number | null>(null);
  const [myCancelTarget, setMyCancelTarget] = useState<Reservation | null>(null);
  const [myCancelBusy, setMyCancelBusy] = useState(false);

  // ── Tab 3: 대기열 상태 ─────────────────────────────────────────────────
  const [waitlist, setWaitlist] = useState<Waitlist[]>([]);
  const [waitlistLoading, setWaitlistLoading] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [waitlistBusy, setWaitlistBusy] = useState(false);

  // ── Tab 4: 공간 관리 (관리자) 상태 ────────────────────────────────────
  const [adminSpaces, setAdminSpaces] = useState<Space[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminNotice, setAdminNotice] = useState<string | null>(null);
  const [adminModal, setAdminModal] = useState<SpaceAdminModalState | null>(null);
  const [adminBusy, setAdminBusy] = useState(false);

  // ── 공간 목록 불러오기 ─────────────────────────────────────────────────
  const loadSpaces = useCallback(async () => {
    spacesRequest.current?.abort();
    const controller = new AbortController();
    spacesRequest.current = controller;
    try {
      setSpacesLoading(true);
      setSpacesError(null);
      const filter: SpaceFilter = {};
      if (minCapacity) filter.minCapacity = Number(minCapacity);
      const raw = await getSpaces(filter, controller.signal);
      const parsed = raw.map((item) => spaceSchema.parse(item));
      if (!controller.signal.aborted) setSpaces(parsed.filter((s) => s.isActive));
    } catch (e: unknown) {
      if (!controller.signal.aborted) setSpacesError(e instanceof Error ? e.message : "공간 목록을 불러오지 못했습니다.");
    } finally {
      if (!controller.signal.aborted) setSpacesLoading(false);
    }
  }, [minCapacity]);

  useEffect(() => () => spacesRequest.current?.abort(), []);

  // ── 내 예약 목록 불러오기 ──────────────────────────────────────────────
  const loadMyReservations = useCallback(async () => {
    try {
      setMyLoading(true);
      setMyError(null);
      const raw = await getMyReservations();
      const parsed = (Array.isArray(raw) ? raw : []).map((item) => reservationSchema.parse(item));
      setMyReservations(parsed);
    } catch (e: unknown) {
      setMyError(e instanceof Error ? e.message : "내 예약 목록을 불러오지 못했습니다.");
    } finally {
      setMyLoading(false);
    }
  }, []);

  // ── 대기열 목록 불러오기 ──────────────────────────────────────────────
  const loadWaitlist = useCallback(async () => {
    try {
      setWaitlistLoading(true);
      setWaitlistError(null);
      const raw = await getMyWaitlist();
      const parsed = (Array.isArray(raw) ? raw : []).map((item) => waitlistSchema.parse(item));
      setWaitlist(parsed);
    } catch (e: unknown) {
      setWaitlistError(e instanceof Error ? e.message : "대기 목록을 불러오지 못했습니다.");
    } finally {
      setWaitlistLoading(false);
    }
  }, []);

  // ── 관리자 공간 목록 불러오기 ──────────────────────────────────────────
  const loadAdminSpaces = useCallback(async () => {
    try {
      setAdminLoading(true);
      setAdminError(null);
      const raw = await getSpaces();
      const parsed = (Array.isArray(raw) ? raw : []).map((item) => spaceSchema.parse(item));
      setAdminSpaces(parsed);
    } catch (e: unknown) {
      setAdminError(e instanceof Error ? e.message : "공간 목록을 불러오지 못했습니다.");
    } finally {
      setAdminLoading(false);
    }
  }, []);

  // ── 초기 탭 진입 시 데이터 로딩 ────────────────────────────────────────
  useEffect(() => {
    if (activeTab === "spaces" && selectedSpaceId === null) {
      void loadSpaces();
    } else if (activeTab === "my") {
      void loadMyReservations();
    } else if (activeTab === "waitlist") {
      void loadWaitlist();
    } else if (activeTab === "admin" && isAdmin) {
      void loadAdminSpaces();
    }
  }, [activeTab, selectedSpaceId, loadSpaces, loadMyReservations, loadWaitlist, loadAdminSpaces, isAdmin]);

  const selectSpace = (space: Space | null) => {
    spacesRequest.current?.abort();
    setSelectedSpace(space);
    setSelectedSpaceId(space?.id ?? null);
    setTimetableDate("");
    setTimetableModal(null);
    setSpacesError(null);
  };
  const selectDay = (day: string) => { setTimetableDate(day); setTimetableModal(null); };

  // ── 예약 핸들러들 ─────────────────────────────────────────────────────
  const handleCreateReservation = async (dto: CreateReservationInput | UpdateReservationInput) => {
    await createReservation(dto as CreateReservationInput);
    setCalendarRevision(value => value + 1);
  };

  const handleUpdateReservation = async (id: number, dto: CreateReservationInput | UpdateReservationInput) => {
    await updateReservation(id, dto as UpdateReservationInput);
    setCalendarRevision(value => value + 1);
  };

  const handleCancelReservation = async (r: Reservation, scope: CancelScope) => {
    try {
      setTimetableBusy(true);
      await cancelReservation(r.id, scope);
      setTimetableModal(null);
      setCalendarRevision(value => value + 1);
    } catch (e: unknown) {
      setSpacesError(e instanceof Error ? e.message : "취소에 실패했습니다.");
    } finally {
      setTimetableBusy(false);
    }
  };

  const handleMyCancelReservation = async (r: Reservation, scope: CancelScope) => {
    try {
      setMyCancelBusy(true);
      await cancelReservation(r.id, scope);
      setMyCancelTarget(null);
      await loadMyReservations();
    } catch (e: unknown) {
      setMyError(e instanceof Error ? e.message : "취소에 실패했습니다.");
    } finally {
      setMyCancelBusy(false);
    }
  };

  const handleCancelWaitlist = async (id: number) => {
    if (!confirm("대기 예약을 취소하시겠습니까?")) return;
    try {
      setWaitlistBusy(true);
      await cancelWaitlist(id);
      await loadWaitlist();
    } catch (e: unknown) {
      setWaitlistError(e instanceof Error ? e.message : "대기 취소에 실패했습니다.");
    } finally {
      setWaitlistBusy(false);
    }
  };

  const handleAddWaitlistFromSlot = async (slot: FreeInterval) => {
    if (!selectedSpaceId) return;
    if (!confirm(`${formatTime(slot.startTime)} ~ ${formatTime(slot.endTime)} 대기 예약을 신청하시겠습니까?`)) return;
    try {
      setTimetableBusy(true);
      await addWaitlist({
        spaceId: selectedSpaceId,
        title: `${selectedSpace?.name ?? "공간"} 대기 신청`,
        startTime: slot.startTime,
        endTime: slot.endTime,
      });
      alert("대기 예약이 완료되었습니다. 대기열 탭에서 확인하실 수 있습니다.");
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "대기 신청에 실패했습니다.");
    } finally {
      setTimetableBusy(false);
    }
  };

  // ── 공간 관리 핸들러들 ─────────────────────────────────────────────────
  const handleCreateSpace = async (dto: Parameters<typeof createSpace>[0]) => {
    await createSpace(dto);
    setAdminNotice("공간이 등록되었습니다.");
    await loadAdminSpaces();
  };

  const handleUpdateSpace = async (id: number, dto: Parameters<typeof updateSpace>[1]) => {
    await updateSpace(id, dto);
    setAdminNotice("공간이 수정되었습니다.");
    await loadAdminSpaces();
  };

  const handleCreateTestSpaces = async () => {
    if (!confirm(`선택한 회사 "${organization?.org_name}"에 테스트 공간 1~5를 등록하시겠습니까? 같은 이름의 기존 공간은 변경하지 않습니다.`)) return;
    try {
      setAdminBusy(true);
      setAdminError(null);
      setAdminNotice(null);
      const result = await createTestSpaces();
      const inactiveCount = result.spaces.filter(space => !space.isActive).length;
      setAdminNotice(`${result.createdCount}개 등록, ${5 - result.createdCount}개 기존 공간 유지.${inactiveCount ? ` 비활성 ${inactiveCount}개는 복구하지 않았습니다.` : ""}`);
      await loadAdminSpaces();
    } catch (e: unknown) {
      setAdminError(e instanceof Error ? e.message : "테스트 공간 등록에 실패했습니다.");
    } finally {
      setAdminBusy(false);
    }
  };

  const handleDeleteSpace = async (space: Space) => {
    if (!confirm(`"${space.name}" 공간을 삭제하시겠습니까?`)) return;
    try {
      setAdminBusy(true);
      await deleteSpace(space.id);
      setAdminNotice("공간이 삭제되었습니다.");
      await loadAdminSpaces();
    } catch (e: unknown) {
      setAdminError(e instanceof Error ? e.message : "삭제에 실패했습니다.");
    } finally {
      setAdminBusy(false);
    }
  };

  const filteredMyReservations =
    myStatusTab === "ALL"
      ? myReservations
      : myReservations.filter((r) => r.status === myStatusTab);

  const myDetailReservation =
    myDetailId != null ? myReservations.find((r) => r.id === myDetailId) : null;

  return (
    <div className="rsv-screen">
      {/* ── 메인 헤더 ──────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: "1.25rem" }}>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: "0.25rem", color: "var(--of-text, #0f172a)" }}>
          {screen.label}
        </h1>
        <p style={{ fontSize: "0.875rem", color: "var(--of-text-muted, #475569)" }}>
          {screen.description}
        </p>
      </div>

      {/* ── 4대 메인 탭 ────────────────────────────────────────────────────── */}
      <div className="rsv-tabs" style={{ marginBottom: "1.5rem" }}>
        <button
          className={`rsv-tab ${activeTab === "spaces" ? "active" : ""}`}
          onClick={() => {
            setActiveTab("spaces");
            selectSpace(null);
          }}
        >
          공간 예약
        </button>
        <button
          className={`rsv-tab ${activeTab === "my" ? "active" : ""}`}
          onClick={() => setActiveTab("my")}
        >
          내 예약
        </button>
        <button
          className={`rsv-tab ${activeTab === "waitlist" ? "active" : ""}`}
          onClick={() => setActiveTab("waitlist")}
        >
          대기열
        </button>
        {isAdmin && (
          <button
            className={`rsv-tab ${activeTab === "admin" ? "active" : ""}`}
            onClick={() => setActiveTab("admin")}
          >
            공간 관리
          </button>
        )}
      </div>

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* TAB 1: 공간 검색 & 예약 / 타임테이블 통합 뷰                        */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {activeTab === "spaces" && (
        <>
          {selectedSpaceId === null ? (
            /* 공간 목록 뷰 */
            <>
              <div className="rsv-filter-bar">
                <label>
                  날짜
                  <input type="date" value={filterDate} onChange={(e) => { if (e.target.value) setFilterDate(e.target.value); }} />
                </label>
                <label>
                  최소 수용인원
                  <input
                    type="number"
                    min={1}
                    value={minCapacity}
                    onChange={(e) => setMinCapacity(e.target.value)}
                    placeholder="전체"
                    style={{ minWidth: 100 }}
                  />
                </label>
                <button className="btn btn-primary" onClick={() => void loadSpaces()} disabled={spacesLoading}>
                  {spacesLoading ? "검색 중..." : "검색"}
                </button>
              </div>

              {spacesError && <div className="rsv-error-banner">{spacesError}</div>}

              <SectionCard title={`공간 목록 (${spaces.length}개)`}>
                {spacesLoading ? (
                  <div className="rsv-empty"><div className="rsv-empty-text">불러오는 중...</div></div>
                ) : spaces.length === 0 ? (
                  <div className="rsv-empty">
                    <div className="rsv-empty-icon">🏢</div>
                    <div className="rsv-empty-text">조건에 맞는 공간이 없습니다. 공간 관리자에게 등록을 요청하세요.</div>
                    {isAdmin && <Link to="/reserve?tab=admin">공간 관리에서 등록</Link>}
                  </div>
                ) : (
                  <div className="rsv-space-grid">
                    {spaces.map((space) => (
                      <div
                        key={space.id}
                        className="rsv-space-card"
                        onClick={() => selectSpace(space)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            selectSpace(space);
                          }
                        }}
                      >
                        <div className="rsv-space-card-header">
                          <h3 className="rsv-space-name">{space.name}</h3>
                          <span className="rsv-space-capacity">최대 {space.capacity}명</span>
                        </div>
                        <div className="rsv-space-meta">
                          <span>📍 {space.location}{space.floor ? ` · ${space.floor}` : ""}</span>
                        </div>
                        {space.amenities && space.amenities.length > 0 && (
                          <div className="rsv-amenity-list">
                            {space.amenities.map((a) => (
                              <span key={a} className="rsv-amenity-badge">{a}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            </>
          ) : (
            /* 선택한 공간의 상세 타임테이블 뷰 */
            <>
              <div className="rsv-selected-space-header">
                <button
                  className="btn btn-ghost"
                  onClick={() => selectSpace(null)}
                  style={{ fontSize: "0.85rem", fontWeight: 600 }}
                >
                  ← 공간 목록으로 돌아가기
                </button>
                <div>
                  <h2 style={{ fontSize: "1.3rem", fontWeight: 700, margin: 0, color: "var(--of-text, #0f172a)" }}>
                    {selectedSpace ? selectedSpace.name : "공간 타임테이블"}
                  </h2>
                  {selectedSpace && (
                    <p style={{ fontSize: "0.8rem", color: "var(--of-text-muted, #475569)", margin: "0.15rem 0 0" }}>
                      📍 {selectedSpace.location}{selectedSpace.floor ? ` · ${selectedSpace.floor}` : ""} · 최대 {selectedSpace.capacity}명
                    </p>
                  )}
                </div>
              </div>

              {spacesError && <div className="rsv-error-banner" role="alert">{spacesError}</div>}
              {selectedSpace && <SpaceMonthCalendar
                key={selectedSpace.id}
                space={selectedSpace}
                initialMonth={filterDate.slice(0, 7)}
                day={timetableDate}
                revision={calendarRevision}
                onSelectDay={selectDay}
                onSelectFree={slot => setTimetableModal({ type: "create", slot })}
                onSelectReservation={reservation => setTimetableModal({ type: "detail", reservation })}
                onSelectBusy={slot => void handleAddWaitlistFromSlot(slot)}
              />}
            </>
          )}
        </>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* TAB 2: 내 예약 목록 뷰                                              */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {activeTab === "my" && (
        <>
          <div className="rsv-tabs">
            {([
              { key: "ALL", label: "전체" },
              { key: "CONFIRMED", label: "예정" },
              { key: "CANCELLED", label: "취소됨" },
            ] as const).map((t) => (
              <button
                key={t.key}
                className={`rsv-tab ${myStatusTab === t.key ? "active" : ""}`}
                onClick={() => setMyStatusTab(t.key)}
              >
                {t.label}
                <span style={{ marginLeft: "0.35rem", fontSize: "0.7rem", opacity: 0.7 }}>
                  ({t.key === "ALL" ? myReservations.length : myReservations.filter((r) => r.status === t.key).length})
                </span>
              </button>
            ))}
          </div>

          {myError && <div className="rsv-error-banner">{myError}</div>}

          <SectionCard title="">
            {myLoading ? (
              <div className="rsv-empty"><div className="rsv-empty-text">불러오는 중...</div></div>
            ) : filteredMyReservations.length === 0 ? (
              <div className="rsv-empty">
                <div className="rsv-empty-icon">📋</div>
                <div className="rsv-empty-text">예약이 없습니다.</div>
              </div>
            ) : (
              <div className="rsv-card-list">
                {filteredMyReservations.map((r) => (
                  <div key={r.id} className={`rsv-reservation-card ${r.status === "CANCELLED" ? "cancelled" : ""}`}>
                    <div className="rsv-card-body">
                      <h3 className="rsv-card-title">{r.title}</h3>
                      <div className="rsv-card-meta">
                        <span>{r.space?.name ?? `공간 #${r.spaceId}`}</span>
                        <span>{formatDateRange(r.startTime, r.endTime)}</span>
                        {r.recurrenceRuleId && (
                          <span style={{ color: "var(--of-primary, #4f46e5)", fontWeight: 500 }}>
                            🔁 {formatRecurrenceRule(r.recurrenceRule) || "반복 예약"}
                          </span>
                        )}
                        {r.attendees && r.attendees.length > 0 && (
                          <span style={{ fontSize: "0.78rem", color: "var(--of-text-muted, #475569)", marginTop: "0.15rem" }}>
                            👥 참석자 {r.attendees.length}명
                            {" ("}
                            수락 {r.attendees.filter((a) => a.status === "ACCEPTED").length}
                            {" · "}
                            대기 {r.attendees.filter((a) => a.status === "INVITED").length}
                            {r.attendees.some((a) => a.status === "DECLINED") && ` · 거절 ${r.attendees.filter((a) => a.status === "DECLINED").length}`}
                            {")"}
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="rsv-card-actions">
                      <span
                        style={{
                          fontSize: "0.72rem",
                          padding: "0.2rem 0.5rem",
                          borderRadius: "99px",
                          background: r.status === "CONFIRMED" ? "var(--of-success-soft, #f0fdf4)" : "var(--of-surface-muted, #f1f5f9)",
                          color: r.status === "CONFIRMED" ? "var(--of-success, #15803d)" : "var(--of-text-muted, #475569)",
                          fontWeight: 600,
                        }}
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                      <button className="btn btn-ghost" style={{ fontSize: "0.75rem" }} onClick={() => setMyDetailId(r.id)}>
                        참석자
                      </button>
                      {r.status === "CONFIRMED" && (
                        <button
                          className="btn btn-ghost"
                          style={{ fontSize: "0.75rem", color: "var(--of-danger, #b91c1c)" }}
                          onClick={() => setMyCancelTarget(r)}
                        >
                          취소
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* TAB 3: 대기열 뷰                                                   */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {activeTab === "waitlist" && (
        <>
          <div className="rsv-success-banner" style={{ marginBottom: "1rem" }}>
            원하는 공간이 꽉 찬 경우 대기 등록을 하면, 앞 예약이 취소될 때 자동으로 승격됩니다.
          </div>

          {waitlistError && <div className="rsv-error-banner">{waitlistError}</div>}

          <SectionCard title={`내 대기 목록 (${waitlist.length}건)`}>
            {waitlistLoading ? (
              <div className="rsv-empty"><div className="rsv-empty-text">불러오는 중...</div></div>
            ) : waitlist.length === 0 ? (
              <div className="rsv-empty">
                <div className="rsv-empty-icon">⏳</div>
                <div className="rsv-empty-text">대기 중인 예약이 없습니다.</div>
                <button
                  className="btn btn-primary"
                  style={{ marginTop: "1rem" }}
                  onClick={() => {
                    setActiveTab("spaces");
                    selectSpace(null);
                  }}
                >
                  공간 둘러보기
                </button>
              </div>
            ) : (
              <div className="rsv-card-list">
                {waitlist.map((w) => (
                  <div key={w.id} className="rsv-reservation-card">
                    <div className="rsv-card-body">
                      <h3 className="rsv-card-title">{w.title}</h3>
                      <div className="rsv-card-meta">
                        <span>{w.space?.name ?? `공간 #${w.spaceId}`}</span>
                        <span>{formatDateRange(w.startTime, w.endTime)}</span>
                        <span style={{ fontSize: "0.75rem", color: "var(--of-text-muted, #475569)" }}>
                          대기 등록: {formatDate(w.createdAt)}
                        </span>
                      </div>
                    </div>
                    <div className="rsv-card-actions">
                      {w.position != null && <span className="rsv-position-badge">대기 {w.position}번</span>}
                      <button
                        className="btn btn-ghost"
                        style={{ fontSize: "0.75rem", color: "var(--of-danger, #b91c1c)" }}
                        onClick={() => void handleCancelWaitlist(w.id)}
                        disabled={waitlistBusy}
                      >
                        대기 취소
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SectionCard>
        </>
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* TAB 4: 공간 관리 (관리자) 뷰                                        */}
      {/* ─────────────────────────────────────────────────────────────────── */}
      {activeTab === "admin" && (
        isAdmin ? (
          <>
            <div style={{ marginBottom: "1.25rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "0.875rem", color: "var(--of-text-muted, #475569)" }}>
              선택한 회사: {organization?.org_name} · 공간을 등록하고 관리합니다.
            </span>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              <Link className="button button--ghost" to="/settings">설정</Link>
              <Button tone="neutral" onClick={() => void handleCreateTestSpaces()} disabled={adminBusy || adminLoading}>
                테스트 공간 1~5 등록
              </Button>
              <Button tone="primary" onClick={() => setAdminModal({ type: "create" })} disabled={adminBusy}>
                + 공간 등록
              </Button>
            </div>
          </div>

          {adminError && <div className="rsv-error-banner" role="alert">{adminError}</div>}
          {adminNotice && (
            <div className="rsv-success-banner" role="status" style={{ cursor: "pointer" }} onClick={() => setAdminNotice(null)}>
              ✓ {adminNotice}
            </div>
          )}

          <SectionCard title={`공간 목록 (${adminSpaces.length}개)`}>
            {adminLoading ? (
              <div className="rsv-empty"><div className="rsv-empty-text">불러오는 중...</div></div>
            ) : adminSpaces.length === 0 ? (
              <div className="rsv-empty">
                <div className="rsv-empty-icon">🏢</div>
                <div className="rsv-empty-text">등록된 공간이 없습니다.</div>
              </div>
            ) : (
              <table className="rsv-admin-table">
                <thead>
                  <tr>
                    <th>공간명</th>
                    <th>위치</th>
                    <th>층</th>
                    <th>수용인원</th>
                    <th>편의시설</th>
                    <th>상태</th>
                    <th>관리</th>
                  </tr>
                </thead>
                <tbody>
                  {adminSpaces.map((space) => (
                    <tr key={space.id}>
                      <td style={{ fontWeight: 700, color: "var(--of-text, #0f172a)" }}>{space.name}</td>
                      <td>{space.location}</td>
                      <td>{space.floor ?? "—"}</td>
                      <td>{space.capacity}명</td>
                      <td>
                        <div className="rsv-amenity-list">
                          {(space.amenities ?? []).slice(0, 3).map((a) => (
                            <span key={a} className="rsv-amenity-badge">{a}</span>
                          ))}
                          {(space.amenities?.length ?? 0) > 3 && (
                            <span className="rsv-amenity-badge">+{(space.amenities?.length ?? 0) - 3}</span>
                          )}
                        </div>
                      </td>
                      <td>
                        <Badge tone={space.isActive ? "success" : "neutral"}>
                          {space.isActive ? "활성" : "비활성"}
                        </Badge>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <button
                            className="btn btn-ghost"
                            style={{ fontSize: "0.75rem" }}
                            onClick={() => setAdminModal({ type: "edit", space })}
                          >
                            수정
                          </button>
                          <button
                            className="btn btn-ghost"
                            style={{ fontSize: "0.75rem", color: "var(--of-danger, #b91c1c)" }}
                            onClick={() => void handleDeleteSpace(space)}
                            disabled={adminBusy}
                          >
                            삭제
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SectionCard>
        </>
        ) : (
          <div className="rsv-empty" style={{ padding: "4rem 1rem" }}>
            <div className="rsv-empty-icon">🔒</div>
            <div className="rsv-empty-text" style={{ fontSize: "1rem", fontWeight: 600, marginTop: "0.5rem" }}>
              공간 등록 및 관리 권한이 필요합니다.
            </div>
            <p style={{ fontSize: "0.85rem", color: "var(--of-text-muted, #475569)", marginTop: "0.25rem" }}>
              일반 사용자 계정은 회의실 검색, 예약, 내 예약 현황 및 대기열 기능을 이용하실 수 있습니다.
            </p>
          </div>
        )
      )}

      {/* ─────────────────────────────────────────────────────────────────── */}
      {/* 모달 렌더링 영역                                                    */}
      {/* ─────────────────────────────────────────────────────────────────── */}

      {/* 타임테이블 뷰: 예약 생성 모달 */}
      {timetableModal?.type === "create" && selectedSpaceId !== null && (
        <ReservationFormModal
          spaceId={selectedSpaceId}
          prefillStart={timetableModal.slot.startTime}
          prefillEnd={timetableModal.slot.endTime}
          onSubmit={handleCreateReservation}
          onClose={() => setTimetableModal(null)}
        />
      )}

      {/* 타임테이블 뷰: 예약 상세/수정 모달 */}
      {(timetableModal?.type === "detail" || timetableModal?.type === "edit") && timetableModal.reservation && (
        <div className="rsv-modal-backdrop" onClick={() => setTimetableModal(null)}>
          <div className="rsv-modal rsv-modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="rsv-modal-header">
              <h2 className="rsv-modal-title">{timetableModal.reservation.title}</h2>
              <button className="rsv-modal-close" onClick={() => setTimetableModal(null)} aria-label="close">
                ✕
              </button>
            </div>
            <p style={{ fontSize: "0.8rem", color: "var(--of-text-muted, #475569)", marginBottom: "1.25rem" }}>
              {formatDate(timetableModal.reservation.startTime)} · {formatTime(timetableModal.reservation.startTime)} – {formatTime(timetableModal.reservation.endTime)}
            </p>
            {timetableModal.reservation.description && (
              <p style={{ fontSize: "0.875rem", marginBottom: "1.25rem" }}>{timetableModal.reservation.description}</p>
            )}
            <div style={{ borderTop: "1px solid var(--of-border, #e2e8f0)", paddingTop: "1rem", marginBottom: "1rem" }}>
              <AttendeePanel reservationId={timetableModal.reservation.id} />
            </div>
            <div className="rsv-modal-footer">
              <button className="btn btn-ghost" onClick={() => setTimetableModal({ type: "cancel", reservation: timetableModal.reservation! })}>
                예약 취소
              </button>
              <button className="btn btn-primary" onClick={() => setTimetableModal({ type: "edit", reservation: timetableModal.reservation! })}>
                수정
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 타임테이블 뷰: 예약 수정 모달 */}
      {timetableModal?.type === "edit" && (
        <ReservationFormModal
          existing={timetableModal.reservation}
          onSubmit={(dto) => handleUpdateReservation(timetableModal.reservation.id, dto)}
          onClose={() => setTimetableModal(null)}
        />
      )}

      {/* 타임테이블 뷰: 반복 예약 취소 범위 선택 모달 */}
      {timetableModal?.type === "cancel" && (
        <CancelScopeModal
          isRecurring={Boolean(timetableModal.reservation.recurrenceRuleId)}
          onConfirm={(scope) => void handleCancelReservation(timetableModal.reservation, scope)}
          onClose={() => setTimetableModal(null)}
          busy={timetableBusy}
        />
      )}

      {/* 내 예약 탭: 참석자 패널 상세 모달 */}
      {myDetailReservation && (
        <div className="rsv-modal-backdrop" onClick={() => setMyDetailId(null)}>
          <div className="rsv-modal rsv-modal-wide" onClick={(e) => e.stopPropagation()}>
            <div className="rsv-modal-header">
              <h2 className="rsv-modal-title">{myDetailReservation.title}</h2>
              <button className="rsv-modal-close" onClick={() => setMyDetailId(null)} aria-label="close">
                ✕
              </button>
            </div>
            <p style={{ fontSize: "0.8rem", color: "var(--of-text-muted, #475569)", marginBottom: "1rem" }}>
              {formatDateRange(myDetailReservation.startTime, myDetailReservation.endTime)}
            </p>
            <AttendeePanel
              reservationId={myDetailReservation.id}
              readonly={myDetailReservation.status === "CANCELLED"}
            />
          </div>
        </div>
      )}

      {/* 내 예약 탭: 취소 모달 */}
      {myCancelTarget && (
        <CancelScopeModal
          isRecurring={Boolean(myCancelTarget.recurrenceRuleId)}
          onConfirm={(scope) => void handleMyCancelReservation(myCancelTarget, scope)}
          onClose={() => setMyCancelTarget(null)}
          busy={myCancelBusy}
        />
      )}

      {/* 공간 관리 탭: 공간 등록 모달 */}
      {isAdmin && adminModal?.type === "create" && (
        <SpaceFormModal
          onSubmit={handleCreateSpace}
          onClose={() => setAdminModal(null)}
        />
      )}

      {/* 공간 관리 탭: 공간 수정 모달 */}
      {isAdmin && adminModal?.type === "edit" && (
        <SpaceFormModal
          existing={adminModal.space}
          onSubmit={(dto) => handleUpdateSpace(adminModal.space.id, dto)}
          onClose={() => setAdminModal(null)}
        />
      )}
    </div>
  );
}
