import { Router } from 'express';
import { asyncRoute } from '../middleware/error.js';
import { authorizeExpenseImport, expenseImportRaw, expenseImportHandler } from '../controllers/expenseImports.controller.js';

export function expenseImportsRouter(source) {
  const router = Router();
  router.use(asyncRoute(authorizeExpenseImport(source)));
  router.post('/uploads', expenseImportRaw, asyncRoute(expenseImportHandler(source, 'upload')));
  router.post('/', asyncRoute(expenseImportHandler(source, 'preview')));
  router.get('/:jobId', asyncRoute(expenseImportHandler(source, 'read')));
  router.get('/:jobId/rows', asyncRoute(expenseImportHandler(source, 'rows')));
  router.post('/:jobId/commit', asyncRoute(expenseImportHandler(source, 'commit')));
  return router;
}
