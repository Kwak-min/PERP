import { cleanupLegacyExpenseImports, cleanupPgExpenseImports } from '../backend/src/services/expense-import.service.js';
import { closeDb } from '../backend/src/config/db.js';
import { closePgPool } from '../backend/src/config/pg.js';

// 운영 스케줄러가 선택 저장소에 명시 호출한다. 업무 장부/job/audit/소비한 원증빙은 삭제하지 않는다.
const store = process.argv[2];
try {
  if (process.argv.length !== 3 || !['legacy', 'perp_db'].includes(store)) throw new Error('Usage: node scripts/cleanup_expense_imports.mjs <legacy|perp_db>');
  const result = store === 'legacy' ? cleanupLegacyExpenseImports() : await cleanupPgExpenseImports();
  console.log(JSON.stringify({ store, ...result }));
} finally {
  closeDb(); await closePgPool();
}
