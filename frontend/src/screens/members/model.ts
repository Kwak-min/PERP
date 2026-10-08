import { z } from "zod";

export const memberProfileSchema = z.object({
  membership_id: z.string(),
  user_id: z.string(),
  email: z.string(),
  name: z.string(),
  roles: z.array(z.string()).catch([]),
  status: z.string().catch("active"),
  department_id: z.string().nullable().catch(null),
  title: z.string().nullable().catch(null),
  phone: z.string().nullable().catch(null),
  address: z.string().nullable().catch(null),
  birth_date: z.string().nullable().catch(null),
  emergency_contact: z.string().nullable().catch(null),
  joined_at: z.string().catch(""),
});

export const memberActivityItemSchema = z.object({
  id: z.string(),
  action: z.string(),
  action_label: z.string(),
  resource_type: z.string(),
  target: z.string().nullable().catch(null),
  actor_name: z.string().catch("알 수 없음"),
  created_at: z.string().catch(""),
});

export const memberActivitySchema = z.object({ items: z.array(memberActivityItemSchema) });

export const memberDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  doc_type: z.string().catch("wiki"),
  visibility: z.string().catch("org"),
});

export const memberDocumentListSchema = z.object({ items: z.array(memberDocumentSchema) });

export const memberAssetSchema = z.object({
  id: z.string(),
  asset_no: z.string(),
  name: z.string(),
  category: z.string().catch("equipment"),
  status: z.string().catch("available"),
});

export const memberAssetListSchema = z.object({ items: z.array(memberAssetSchema) });

export const memberCompetencySchema = z.object({
  id: z.string(),
  member_id: z.string(),
  label: z.string(),
  level: z.string().catch("intermediate"),
  note: z.string().catch(""),
});

export const memberCompetencyListSchema = z.object({ items: z.array(memberCompetencySchema) });

export const memberFieldRequestSchema = z.object({
  id: z.string(),
  member_id: z.string(),
  field: z.string(),
  old_value: z.string().nullable().catch(null),
  new_value: z.string(),
  status: z.string().catch("pending"),
  comment: z.string().catch(""),
  created_at: z.string().catch(""),
  decided_at: z.string().nullable().catch(null),
});

export const memberFieldRequestListSchema = z.object({ items: z.array(memberFieldRequestSchema) });

export type MemberProfile = z.infer<typeof memberProfileSchema>;
export type MemberActivityItem = z.infer<typeof memberActivityItemSchema>;
export type MemberDocument = z.infer<typeof memberDocumentSchema>;
export type MemberAsset = z.infer<typeof memberAssetSchema>;
export type MemberCompetency = z.infer<typeof memberCompetencySchema>;
export type MemberFieldRequest = z.infer<typeof memberFieldRequestSchema>;

export const ASSIGNMENT_ACTION = "member.assignment.changed";

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  phone: "전화번호",
  address: "주소",
  birth_date: "생년월일",
  emergency_contact: "비상연락처",
};

export const LEVEL_LABELS: Readonly<Record<string, string>> = {
  beginner: "초급",
  intermediate: "중급",
  advanced: "고급",
};
