import type { ComponentType } from "react";

import type { ScreenDefinition } from "../routes/catalog";
import { AdminScreen } from "./AdminScreen";
import { AgentPage } from "./AgentPage";
import { AiPolicyScreen } from "./AiPolicyScreen";
import { AnalyticsScreen } from "./AnalyticsScreen";
import { ApprovalFormsScreen } from "./ApprovalFormsScreen";
import { ApprovalsScreen } from "./ApprovalsScreen";
import { AssetsScreen } from "./AssetsScreen";
import { AuditScreen } from "./AuditScreen";
import { AttendanceScreen } from "./AttendanceScreen";
import { BranchSettingsScreen } from "./BranchSettingsScreen";
import { BudgetsScreen } from "./BudgetsScreen";
import { CalendarScreen } from "./CalendarScreen";
import { CloseScreen } from "./CloseScreen";
import { DataScreen } from "./DataScreen";
import { DocumentsScreen } from "./DocumentsScreen";
import { DuesScreen } from "./DuesScreen";
import { FinanceScreen } from "./FinanceScreen";
import { HandoverScreen } from "./HandoverScreen";
import { HomeScreen } from "./HomeScreen";
import { LeaveScreen } from "./LeaveScreen";
import { MeetingsScreen } from "./MeetingsScreen";
import { MembersScreen } from "./MembersScreen";
import { NotificationsScreen } from "./NotificationsScreen";
import { OrgChartScreen } from "./OrgChartScreen";
import { OrgLogScreen } from "./OrgLogScreen";
import { OrgSettingsScreen } from "./OrgSettingsScreen";
import { IntegrationsScreen } from "./IntegrationsScreen";
import { ProjectsScreen } from "./ProjectsScreen";
import { ReservationsScreen } from "./ReservationsScreen";
import { RolesScreen } from "./RolesScreen";
import { SettlementsScreen } from "./SettlementsScreen";
import { TasksScreen } from "./TasksScreen";
import { TransactionsScreen } from "./TransactionsScreen";
import { VaultGraphScreen } from "./VaultGraphScreen";
import { WorkloadScreen } from "./WorkloadScreen";
import { VaultScreen } from "./VaultScreen";

export type ScreenComponent = ComponentType<Readonly<{ screen: ScreenDefinition }>>;

/**
 * 화면 ID별 전용 화면. 여기 없는 화면은 공통 ScreenPage가 렌더한다.
 */
export const screenOverrides: Readonly<Record<string, ScreenComponent>> = {
  "DASH-001": HomeScreen,
  "NOT-001": NotificationsScreen,
  "AGT-001": AgentPage,
  "PRJ-001": ProjectsScreen,
  "TSK-001": TasksScreen,
  "TSK-005": WorkloadScreen,
  "CAL-001": CalendarScreen,
  "FIN-001": FinanceScreen,
  "FIN-002": TransactionsScreen,
  "FIN-003": BudgetsScreen,
  "FIN-004": DuesScreen,
  "FIN-005": SettlementsScreen,
  "FIN-006": CloseScreen,
  "AST-001": AssetsScreen,
  "AST-003": ReservationsScreen,
  "HR-003": LeaveScreen,
  "DOC-001": DocumentsScreen,
  "DOC-003L": MeetingsScreen,
  "HND-001": HandoverScreen,
  "APR-001": ApprovalsScreen,
  "ORG-002": MembersScreen,
  "ORG-004": RolesScreen,
  "INT-001": IntegrationsScreen,
  "ADM-001": AdminScreen,
  "ADM-002": AuditScreen,
  "ADM-003": AiPolicyScreen,
  "ADM-004": DataScreen,
  "ORG-001": OrgSettingsScreen,
  "SET-001": ApprovalFormsScreen,
  "ANL-001": AnalyticsScreen,
  "ORG-003": OrgChartScreen,
  "ORG-005": BranchSettingsScreen,
  "ORG-006": OrgLogScreen,
  "HR-002": AttendanceScreen,
  "VLT-001": VaultScreen,
  "VLT-002": VaultGraphScreen,
};
