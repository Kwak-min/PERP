import { z } from "zod";

export const orgMemberSchema = z.object({
  membership_id: z.string(),
  user_id: z.string(),
  email: z.string(),
  name: z.string(),
  roles: z.array(z.string()).catch([]),
  status: z.string(),
  department_id: z.string().nullable().catch(null),
  title: z.string().nullable().catch(null),
  phone: z.string().nullable().catch(null),
  address: z.string().nullable().catch(null),
  birth_date: z.string().nullable().catch(null),
});

export type OrgMember = z.infer<typeof orgMemberSchema>;

export type OrgSeat = Readonly<{
  id: string;
  name: string;
  parent_id: string | null;
  leader_id: string | null;
  configured: boolean;
  leader: OrgMember | null;
  member_count: number;
  members: readonly OrgMember[];
  children: readonly OrgSeat[];
}>;

const seatSchema: z.ZodType<OrgSeat> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    parent_id: z.string().nullable().catch(null),
    leader_id: z.string().nullable().catch(null),
    configured: z.boolean().catch(false),
    leader: orgMemberSchema.nullable().catch(null),
    member_count: z.number().catch(0),
    members: z.array(orgMemberSchema).catch([]),
    children: z.array(seatSchema).catch([]),
  }),
);

export const orgChartSchema = z.object({
  revision: z.string().regex(/^[1-9]\d*$/).optional(),
  roots: z.array(seatSchema),
  unassigned: z.array(orgMemberSchema).catch([]),
});

export type OrgChart = z.infer<typeof orgChartSchema>;

export const membersSchema = z.object({ items: z.array(orgMemberSchema) });

/** 직책 승급·하락 사다리. 위로 갈수록 상위 직책이다. */
export const TITLE_LADDER = [
  "인턴",
  "사원",
  "선임",
  "책임",
  "팀장",
  "부서장",
  "이사",
  "대표",
] as const;

const DEFAULT_TITLE_INDEX = 1;

export function titleIndexOf(title: string | null): number {
  if (!title) return DEFAULT_TITLE_INDEX;
  const found = TITLE_LADDER.indexOf(title.trim() as (typeof TITLE_LADDER)[number]);
  return found === -1 ? DEFAULT_TITLE_INDEX : found;
}

export function promotedTitle(title: string | null): string | null {
  const index = titleIndexOf(title);
  return index >= TITLE_LADDER.length - 1 ? null : (TITLE_LADDER[index + 1] ?? null);
}

export function demotedTitle(title: string | null): string | null {
  const index = titleIndexOf(title);
  return index <= 0 ? null : (TITLE_LADDER[index - 1] ?? null);
}

export const PERMISSION_LABELS = [
  { key: "view", label: "조직 조회" },
  { key: "assign", label: "업무 배정" },
  { key: "approve", label: "승인 가능" },
  { key: "finance", label: "회계 관리" },
] as const;

export type SeatPermission = (typeof PERMISSION_LABELS)[number]["key"];

/** 역할에서 조직도에 표시할 권한 배지를 유도한다. */
export function permissionsOf(roles: readonly string[]): readonly SeatPermission[] {
  const out = new Set<SeatPermission>(["view"]);
  for (const role of roles) {
    if (role === "owner" || role === "org_admin" || role === "chair") {
      out.add("assign");
      out.add("approve");
      out.add("finance");
    }
    if (role === "dept_lead" || role === "pm") {
      out.add("assign");
      out.add("approve");
    }
    if (role === "treasurer") out.add("finance");
    if (role === "hr") out.add("approve");
  }
  return PERMISSION_LABELS.map(({ key }) => key).filter((key) => out.has(key));
}

export function seatLabel(seat: OrgSeat): string {
  if (!seat.configured || !seat.leader) return "설정";
  return seat.leader.name;
}

export function flattenSeats(roots: readonly OrgSeat[]): readonly OrgSeat[] {
  return roots.flatMap((seat) => [seat, ...flattenSeats(seat.children)]);
}
