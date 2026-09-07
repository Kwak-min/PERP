/**
 * Reservation 백엔드 전용 API 서비스
 * BASE URL: VITE_RESERVATION_API_URL (기본값: http://localhost:8080)
 *
 */

import type {
  AddAttendeeInput,
  AddWaitlistInput,
  CancelScope,
  CreateReservationInput,
  CreateSpaceInput,
  UpdateReservationInput,
} from "../screens/reservation/model";
import { sessionStore } from "../store/session";
import { z } from "zod";
import { spaceSchema } from "../screens/reservation/model";

const RESERVATION_API_BASE =
  import.meta.env.VITE_RESERVATION_API_URL ?? "http://localhost:8080";

async function rsvFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  const session = sessionStore.getSnapshot();
  if (session?.token) headers.set("Authorization", `Bearer ${session.token}`);
  if (session?.orgId) headers.set("X-Org-Id", session.orgId);

  const res = await fetch(`${RESERVATION_API_BASE}${path}`, {
    ...options,
    headers,
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });

  if (res.status === 204 || res.status === 205) return null as T;

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    if (res.status === 401) sessionStore.clear();
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

export async function createTestSpaces() {
  const raw = await rsvFetch<unknown>("/api/v1/spaces/test-spaces", {
    method: "POST",
    body: JSON.stringify({}),
  });
  return z.object({ spaces: z.array(spaceSchema), createdCount: z.number().int().nonnegative() }).parse(raw);
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
}

export function getReservations(filter: ReservationFilter = {}) {
  const params = new URLSearchParams();
  if (filter.spaceId != null) params.set("spaceId", String(filter.spaceId));
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  const qs = params.toString();
  return rsvFetch<unknown[]>(`/api/v1/reservations${qs ? `?${qs}` : ""}`);
}

export function getMyReservations() {
  return rsvFetch<unknown[]>("/api/v1/reservations?mine=true");
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
    body: JSON.stringify(dto),
  });
}

export function updateReservation(id: number, dto: UpdateReservationInput) {
  return rsvFetch<unknown>(
    `/api/v1/reservations/${id}`,
    {
      method: "PATCH",
      body: JSON.stringify(dto),
    },
  );
}

export function cancelReservation(id: number, cancelScope: CancelScope = "THIS") {
  return rsvFetch<unknown>(
    `/api/v1/reservations/${id}?cancelScope=${cancelScope}`,
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
  return rsvFetch<unknown[]>("/api/v1/waitlist");
}

export function addWaitlist(dto: AddWaitlistInput) {
  return rsvFetch<unknown>("/api/v1/waitlist", {
    method: "POST",
    body: JSON.stringify(dto),
  });
}

export function cancelWaitlist(id: number) {
  return rsvFetch<unknown>(
    `/api/v1/waitlist/${id}`,
    { method: "DELETE" },
  );
}
