/**
 * Reservation 백엔드 전용 API 서비스
 * BASE URL: VITE_RESERVATION_API_URL (기본값: http://localhost:8080)
 *
 * userId: 현재 개발 단계에서는 1로 고정.
 * TODO: 실제 세션의 userId로 교체 필요
 */

import type {
  AddAttendeeInput,
  AddWaitlistInput,
  CancelScope,
  CreateReservationInput,
  CreateSpaceInput,
  UpdateReservationInput,
} from "../screens/reservation/model";

const RESERVATION_API_BASE =
  import.meta.env.VITE_RESERVATION_API_URL ?? "http://localhost:8080";

// TODO: 실제 세션 연동 시 session.userId로 교체
const DEV_USER_ID = 1;

async function rsvFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");

  const res = await fetch(`${RESERVATION_API_BASE}${path}`, {
    ...options,
    headers,
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });

  if (res.status === 204 || res.status === 205) return null as T;

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    const message =
      payload?.error?.message ?? `요청 실패 (HTTP ${res.status})`;
    throw new Error(message);
  }

  // 백엔드 응답 형식: { success, data, message }
  return (payload?.data ?? payload) as T;
}

// ── 공간(Space) ────────────────────────────────────────────────────────────

export interface SpaceFilter {
  minCapacity?: number;
  startTime?: string;
  endTime?: string;
}

export function getSpaces(filter: SpaceFilter = {}) {
  const params = new URLSearchParams();
  if (filter.minCapacity != null)
    params.set("minCapacity", String(filter.minCapacity));
  if (filter.startTime) params.set("startTime", filter.startTime);
  if (filter.endTime) params.set("endTime", filter.endTime);
  const qs = params.toString();
  return rsvFetch<unknown[]>(`/api/v1/spaces${qs ? `?${qs}` : ""}`);
}

export function getSpaceById(id: number) {
  return rsvFetch<unknown>(`/api/v1/spaces/${id}`);
}

export function createSpace(dto: CreateSpaceInput) {
  return rsvFetch<unknown>("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify(dto),
  });
}

export function updateSpace(id: number, dto: Partial<CreateSpaceInput>) {
  return rsvFetch<unknown>(`/api/v1/spaces/${id}`, {
    method: "PATCH",
    body: JSON.stringify(dto),
  });
}

export function deleteSpace(id: number) {
  return rsvFetch<null>(`/api/v1/spaces/${id}`, { method: "DELETE" });
}

// ── 예약(Reservation) ──────────────────────────────────────────────────────

export interface ReservationFilter {
  spaceId?: number;
  from?: string;
  to?: string;
  userId?: number;
}

export function getReservations(filter: ReservationFilter = {}) {
  const params = new URLSearchParams();
  if (filter.spaceId != null) params.set("spaceId", String(filter.spaceId));
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.userId != null) params.set("userId", String(filter.userId));
  const qs = params.toString();
  return rsvFetch<unknown[]>(`/api/v1/reservations${qs ? `?${qs}` : ""}`);
}

export function getMyReservations() {
  return getReservations({ userId: DEV_USER_ID });
}

export function getReservationById(id: number) {
  return rsvFetch<unknown>(`/api/v1/reservations/${id}`);
}

export function getTimetable(spaceId: number, date: string, slotMinutes = 60) {
  const params = new URLSearchParams({
    spaceId: String(spaceId),
    date,
    slotMinutes: String(slotMinutes),
  });
  return rsvFetch<unknown>(`/api/v1/reservations/timetable?${params}`);
}

export function createReservation(dto: CreateReservationInput) {
  return rsvFetch<unknown>("/api/v1/reservations", {
    method: "POST",
    body: JSON.stringify({ ...dto, userId: DEV_USER_ID }),
  });
}

export function updateReservation(id: number, dto: UpdateReservationInput) {
  return rsvFetch<unknown>(
    `/api/v1/reservations/${id}?userId=${DEV_USER_ID}`,
    {
      method: "PATCH",
      body: JSON.stringify(dto),
    },
  );
}

export function cancelReservation(id: number, cancelScope: CancelScope = "THIS") {
  return rsvFetch<unknown>(
    `/api/v1/reservations/${id}?userId=${DEV_USER_ID}&cancelScope=${cancelScope}`,
    { method: "DELETE" },
  );
}

// ── 참석자(Attendee) ───────────────────────────────────────────────────────

export function getAttendees(reservationId: number) {
  return rsvFetch<unknown[]>(
    `/api/v1/reservations/${reservationId}/attendees`,
  );
}

export function addAttendee(reservationId: number, dto: AddAttendeeInput) {
  return rsvFetch<unknown>(
    `/api/v1/reservations/${reservationId}/attendees`,
    {
      method: "POST",
      body: JSON.stringify(dto),
    },
  );
}

export function removeAttendee(reservationId: number, attendeeId: number) {
  return rsvFetch<null>(
    `/api/v1/reservations/${reservationId}/attendees/${attendeeId}`,
    { method: "DELETE" },
  );
}

export function respondInvite(token: string, accept: boolean) {
  return rsvFetch<unknown>(
    `/api/v1/attendees/${token}/respond?accept=${accept}`,
    { method: "PATCH" },
  );
}

// ── 대기열(Waitlist) ───────────────────────────────────────────────────────

export function getMyWaitlist() {
  return rsvFetch<unknown[]>(
    `/api/v1/waitlist?userId=${DEV_USER_ID}`,
  );
}

export function addWaitlist(dto: AddWaitlistInput) {
  return rsvFetch<unknown>("/api/v1/waitlist", {
    method: "POST",
    body: JSON.stringify({ ...dto, userId: DEV_USER_ID }),
  });
}

export function cancelWaitlist(id: number) {
  return rsvFetch<unknown>(
    `/api/v1/waitlist/${id}?userId=${DEV_USER_ID}`,
    { method: "DELETE" },
  );
}
