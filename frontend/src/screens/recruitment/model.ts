import { z } from "zod";

export const STAGES = ["applied", "screening", "interview", "offer", "hired", "rejected"] as const;

export const STAGE_LABELS: Readonly<Record<string, string>> = {
  applied: "지원 접수",
  screening: "서류 검토",
  interview: "면접",
  offer: "처우 협의",
  hired: "합격",
  rejected: "불합격",
};

export const postingSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string().catch("open"),
  closes_on: z.string().nullable().catch(null),
  created_at: z.string().catch(""),
});

export const postingListSchema = z.object({ items: z.array(postingSchema) });

export const applicationSchema = z.object({
  id: z.string(),
  posting_id: z.string(),
  applicant_name: z.string(),
  applicant_email: z.string(),
  applicant_phone: z.string().nullable().catch(null),
  score: z.number().nullable().catch(null),
  stage: z.string().catch("applied"),
  retain_until: z.string().nullable().catch(null),
});

export const applicationListSchema = z.object({ items: z.array(applicationSchema) });

export const onboardingItemSchema = z.object({
  id: z.string(),
  member_id: z.string(),
  flow: z.string().catch("onboarding"),
  label: z.string(),
  done: z.boolean().catch(false),
});

export const onboardingListSchema = z.object({
  items: z.array(onboardingItemSchema),
  progress: z.object({ total: z.number().catch(0), done: z.number().catch(0) }).catch({ total: 0, done: 0 }),
});

export type Posting = z.infer<typeof postingSchema>;
export type Application = z.infer<typeof applicationSchema>;
export type OnboardingItem = z.infer<typeof onboardingItemSchema>;

/** 오늘부터 6개월 뒤 날짜(YYYY-MM-DD) — 지원자 개인정보 보존기한 기본값. */
export function sixMonthsFromToday(): string {
  const date = new Date();
  date.setMonth(date.getMonth() + 6);
  return date.toISOString().slice(0, 10);
}
