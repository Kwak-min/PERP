import type { ComponentType } from "react";

import type { ScreenDefinition } from "../routes/catalog";
import { AttendanceScreen } from "./AttendanceScreen";
import { BranchSettingsScreen } from "./BranchSettingsScreen";
import { LeaveScreen } from "./LeaveScreen";
import { OrgChartScreen } from "./OrgChartScreen";
import { OrgLogScreen } from "./OrgLogScreen";
import { RecruitmentScreen } from "./RecruitmentScreen";
import { VaultScreen } from "./VaultScreen";
import { ReservationScreen } from "./ReservationScreen";

export type ScreenComponent = ComponentType<Readonly<{ screen: ScreenDefinition }>>;

/**
 * 화면 ID별 전용 화면. 여기 없는 화면은 공통 ScreenPage가 렌더한다.
 */
export const screenOverrides: Readonly<Record<string, ScreenComponent>> = {
  "ORG-003": OrgChartScreen,
  "ORG-005": BranchSettingsScreen,
  "ORG-006": OrgLogScreen,
  "HR-002": AttendanceScreen,
  "HR-003": LeaveScreen,
  "HR-004": RecruitmentScreen,
  "VLT-001": VaultScreen,
  // ── 예약 시스템 (통합 화면) ──────────────────────────────────
  "RSV-001": ReservationScreen,
};
