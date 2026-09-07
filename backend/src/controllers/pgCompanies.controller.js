import { z } from 'zod';
import { pgIdentity } from '../middleware/pgAccess.js';
import { validateSelection } from '../middleware/modules.js';
import { createPgCompany } from '../services/pg-company.service.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  modules: z.array(z.string()).max(100).default([]),
  departments: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
}).strict();

export async function createCompany(req, res) {
  // 회사 소속이 없어도 검증된 활성 PG 계정은 새 회사를 만들 수 있다.
  const { userId } = pgIdentity(req);
  const payload = createSchema.parse(req.body);
  res.status(201).json(await createPgCompany(userId, {
    ...payload, modules: validateSelection(payload.modules), departments: [...new Set(payload.departments)],
  }));
}
