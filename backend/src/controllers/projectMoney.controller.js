import { legacyProjectMoney, legacyProjectBudget, pgProjectMoney, pgProjectBudget } from '../services/project-money.service.js';
export function legacySummary(req, res) { res.json(legacyProjectMoney(req)); }
export function legacyCreateBudget(req, res) { res.status(201).json(legacyProjectBudget(req)); }
export function legacyAssociateBudget(req, res) { res.json(legacyProjectBudget(req, true)); }
export async function pgSummary(req, res) { res.json(await pgProjectMoney(req)); }
export async function pgCreateBudget(req, res) { res.status(201).json(await pgProjectBudget(req)); }
export async function pgAssociateBudget(req, res) { res.json(await pgProjectBudget(req, true)); }
