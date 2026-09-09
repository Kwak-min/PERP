import type { ComponentType } from "react";

import type { ScreenDefinition } from "../routes/catalog";
import { AttendanceScreen } from "./AttendanceScreen";
import { ApiKeySettingsScreen } from "./ApiKeySettingsScreen";
import { BranchSettingsScreen } from "./BranchSettingsScreen";
import { LeaveScreen } from "./LeaveScreen";
import { OrgChartScreen } from "./OrgChartScreen";
import { OrgLogScreen } from "./OrgLogScreen";
import { RecruitmentScreen } from "./RecruitmentScreen";
import { VaultScreen } from "./VaultScreen";
import { VaultGraphScreen } from "./VaultGraphScreen";
import { KnowledgeGraphScreen } from "./KnowledgeGraphScreen";
import { HomeBuilderScreen } from "./HomeBuilderScreen";
import { OrgModulesScreen } from "./OrgModulesScreen";
import { ReservationScreen } from "./ReservationScreen";
import { RoleSettingsScreen } from './RoleSettingsScreen';
import { SettingsScreen } from './SettingsScreen';
import { ProjectTaskScreen } from './ProjectTaskScreen';
import { DailyFinanceScreen } from './DailyFinanceScreen';
import { ExpenseScreen } from './ExpenseScreen';
import { ApprovalsScreen } from './ApprovalsScreen';

export type ScreenComponent = ComponentType<Readonly<{ screen: ScreenDefinition }>>;

/**
 * 화면 ID별 전용 화면. 여기 없는 화면은 공통 ScreenPage가 렌더한다.
 */
export const screenOverrides: Readonly<Record<string, ScreenComponent>> = {
  'APR-001': ApprovalsScreen,
  'FIN-004': DailyFinanceScreen,
  'FIN-001': ExpenseScreen,
  'FIN-002': ExpenseScreen,
  "ORG-001": OrgModulesScreen,
  'ORG-002': OrgChartScreen,
  "ORG-003": OrgChartScreen,
  'ORG-004': RoleSettingsScreen,
  'PRJ-001': ProjectTaskScreen,
  'PRJ-002': ProjectTaskScreen,
  'TSK-001': ProjectTaskScreen,
  'TSK-003': ProjectTaskScreen,
  "ORG-005": BranchSettingsScreen,
  "ORG-006": OrgLogScreen,
  "HR-002": AttendanceScreen,
  "HR-003": LeaveScreen,
  "HR-004": RecruitmentScreen,
  "VLT-001": VaultScreen,
  "VLT-002": VaultGraphScreen,
  "DOC-004": KnowledgeGraphScreen,
  "DASH-002": HomeBuilderScreen,
  "SET-002": ApiKeySettingsScreen,
  'SET-003': SettingsScreen,
  'ADM-001': SettingsScreen,
  // ── 예약 시스템 (통합 화면) ──────────────────────────────────
  "RSV-001": ReservationScreen,
};
