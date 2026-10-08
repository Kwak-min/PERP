-- 기존 행은 명시적 관리자 배정 전까지 NULL로 격리한다. 소유권을 추측하지 않는다.
ALTER TABLE "spaces" ADD COLUMN "tenantId" TEXT, ADD COLUMN "orgId" TEXT;
ALTER TABLE "recurrence_rules" ADD COLUMN "tenantId" TEXT, ADD COLUMN "orgId" TEXT;
ALTER TABLE "reservations" ADD COLUMN "tenantId" TEXT, ADD COLUMN "orgId" TEXT, ADD COLUMN "ownerId" TEXT;
ALTER TABLE "waitlists" ADD COLUMN "tenantId" TEXT, ADD COLUMN "orgId" TEXT, ADD COLUMN "ownerId" TEXT;
ALTER TABLE "reservations" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "waitlists" ALTER COLUMN "userId" DROP NOT NULL;

CREATE INDEX "spaces_tenantId_orgId_idx" ON "spaces"("tenantId", "orgId");
CREATE INDEX "reservations_tenantId_orgId_ownerId_idx" ON "reservations"("tenantId", "orgId", "ownerId");
CREATE INDEX "waitlists_tenantId_orgId_ownerId_idx" ON "waitlists"("tenantId", "orgId", "ownerId");

CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "reservations" ADD CONSTRAINT "no_overlap_reservation_org" EXCLUDE USING gist (
  "tenantId" WITH =, "orgId" WITH =, "spaceId" WITH =,
  tsrange("startTime", "endTime", '[)') WITH &&
) WHERE ("status" = 'CONFIRMED' AND "tenantId" IS NOT NULL AND "orgId" IS NOT NULL);
