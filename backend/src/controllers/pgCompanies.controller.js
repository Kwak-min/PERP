import { z } from 'zod';
import { pgIdentity } from '../middleware/pgAccess.js';
import { modulesForFeatures, validateFeatureSelection } from '../config/features.js';
import { validateSelection } from '../middleware/modules.js';
import { createPgCompany } from '../services/pg-company.service.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(['company', 'personal', 'club', 'lab']).default('company'),
  modules: z.array(z.string()).max(100).default([]),
  features: z.array(z.string()).max(3).default([]),
  departments: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
}).strict();

export async function createCompany(req, res) {
  // 회사 소속이 없어도 검증된 활성 PG 계정은 새 회사를 만들 수 있다.
  const { userId } = pgIdentity(req);
  const payload = createSchema.parse(req.body);
  if (payload.type === 'personal') payload.name = req.appUser.name;
  const features = validateFeatureSelection(payload.features);
  const modules = modulesForFeatures(validateSelection(payload.modules), features);
  res.status(201).json(await createPgCompany(userId, {
    ...payload, modules, features, departments: [...new Set(payload.departments)],
  }));
}
