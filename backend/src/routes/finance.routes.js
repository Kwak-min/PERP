import { Router } from "express";

import * as controller from "../controllers/finance.controller.js";
import { asyncRoute } from "../middleware/error.js";

import { authorizeReceiptUpload, receiptRaw, uploadReceipt, downloadReceipt } from '../controllers/receiptFiles.controller.js';

export const financeRouter = Router();
financeRouter.post('/transactions/receipt-uploads', asyncRoute(authorizeReceiptUpload('legacy', 'transaction')), receiptRaw, asyncRoute(uploadReceipt('legacy', 'transaction')));
financeRouter.get('/transactions/:id/receipts/:fileId', asyncRoute(downloadReceipt('legacy', 'transaction')));

financeRouter.post("/accounts", asyncRoute(controller.createAccount));
financeRouter.get("/accounts", asyncRoute(controller.listAccounts));

financeRouter.post("/transactions", asyncRoute(controller.createTransaction));
financeRouter.get("/transactions", asyncRoute(controller.listTransactions));
financeRouter.patch("/transactions/:transactionId", asyncRoute(controller.patchTransaction));
financeRouter.post("/transactions/:transactionId/confirm", asyncRoute(controller.confirmTransaction));

financeRouter.post("/budgets", asyncRoute(controller.createBudget));
financeRouter.get("/budgets", asyncRoute(controller.listBudgets));

financeRouter.post("/dues/rules", asyncRoute(controller.createDuesRule));
financeRouter.post("/dues/charges", asyncRoute(controller.createDuesCharges));
financeRouter.get("/dues/charges", asyncRoute(controller.listDuesCharges));
financeRouter.post("/dues/charges/:chargeId/pay", asyncRoute(controller.payDues));
financeRouter.post("/dues/charges/:chargeId/exempt", asyncRoute(controller.exemptDues));

financeRouter.post("/settlements", asyncRoute(controller.createSettlement));
financeRouter.post("/settlements/:settlementId/post", asyncRoute(controller.postSettlement));

financeRouter.get("/ledger", asyncRoute(controller.ledger));
financeRouter.get("/reports/summary", asyncRoute(controller.reportSummary));

financeRouter.get("/close", asyncRoute(controller.listLocks));
financeRouter.post("/close", asyncRoute(controller.closePeriod));
financeRouter.post("/close/reopen-request", asyncRoute(controller.requestReopen));
financeRouter.post("/close/reopen", asyncRoute(controller.reopenPeriod));
