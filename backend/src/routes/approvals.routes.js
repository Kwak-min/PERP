import { Router } from "express";

import * as controller from "../controllers/approvals.controller.js";
import { asyncRoute } from "../middleware/error.js";
import { requireFeature } from "../middleware/features.js";

import { authorizeReceiptUpload, receiptRaw, uploadReceipt, downloadReceipt } from '../controllers/receiptFiles.controller.js';

export const approvalsRouter = Router();

approvalsRouter.use(requireFeature("approvals"));
approvalsRouter.post('/receipt-uploads', asyncRoute(authorizeReceiptUpload('legacy', 'approval')), receiptRaw, asyncRoute(uploadReceipt('legacy', 'approval')));
approvalsRouter.get('/requests/:id/receipts/:fileId', asyncRoute(downloadReceipt('legacy', 'approval')));

approvalsRouter.post("/forms", asyncRoute(controller.createForm));
approvalsRouter.get("/forms", asyncRoute(controller.listForms));
approvalsRouter.post("/requests", asyncRoute(controller.requestApproval));
approvalsRouter.get("/requests", asyncRoute(controller.listRequests));
approvalsRouter.get("/requests/:approvalId", asyncRoute(controller.getRequest));
approvalsRouter.post("/requests/:approvalId/actions", asyncRoute(controller.decide));
approvalsRouter.post("/requests/:approvalId/withdraw", asyncRoute(controller.withdraw));
approvalsRouter.post("/requests/:approvalId/delegate", asyncRoute(controller.delegate));
