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

export type MemberProfile = z.infer<typeof memberProfileSchema>;
export type MemberActivityItem = z.infer<typeof memberActivityItemSchema>;
export type MemberDocument = z.infer<typeof memberDocumentSchema>;
export type MemberAsset = z.infer<typeof memberAssetSchema>;

export const ASSIGNMENT_ACTION = "member.assignment.changed";
