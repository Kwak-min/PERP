import { z } from "zod";

import { db } from "../config/db.js";
import { resolvePrincipal } from "../middleware/auth.js";
import { getScoped, insert, listScoped, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { ApiError } from "../utils/errors.js";

const importSchema = z.object({
  kind: z.enum(["members", "transactions", "assets", "tasks"]),
  csv: z.string().min(1),
  dry_run: z.boolean().default(true),
  request_key: z.string().nullable().optional(),
});

const commitSchema = z.object({
  csv: z.string().min(1),
  request_key: z.string().nullable().optional(),
});

const memberRow = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  roles: z.string().default("member"),
  department: z.string().default(""),
});

const transactionRow = z.object({
  kind: z.enum(["income", "expense"]),
  amount_minor: z.coerce.number().int(),
  occurred_on: z.string().min(8),
  memo: z.string().default(""),
});

const assetRow = z.object({
  asset_no: z.string().min(1),
  name: z.string().min(1),
  category: z.string().default("equipment"),
  quantity: z.coerce.number().int().default(1),
});

const taskRow = z.object({
  title: z.string().min(1),
  status: z.string().default("todo"),
  priority: z.string().default("normal"),
  due_at: z.string().nullable().optional(),
});

const KINDS = {
  members: { schema: memberRow, permission: "member.write", table: "membership" },
  transactions: { schema: transactionRow, permission: "transaction.write", table: "transaction_record" },
  assets: { schema: assetRow, permission: "asset.write", table: "asset" },
  tasks: { schema: taskRow, permission: "task.write", table: "task" },
};

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseCsv(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new ApiError("VALIDATION_ERROR", "CSV에 헤더와 최소 1개 행이 필요합니다");
  }
  const header = splitCsvLine(lines[0]);
  return lines.slice(1).map((line, index) => {
    const cells = splitCsvLine(line);
    const record = Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ""]));
    return { line: index + 2, record };
  });
}

function validate(kind, rows) {
  const { schema } = KINDS[kind];
  const valid = [];
  const errors = [];
  for (const row of rows) {
    const parsed = schema.safeParse(row.record);
    if (parsed.success) {
      valid.push({ line: row.line, values: parsed.data });
    } else {
      errors.push({
        line: row.line,
        issues: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      });
    }
  }
  return { valid, errors };
}

function applyMembers(principal, rows) {
  const created = [];
  for (const row of rows) {
    const existing = db()
      .prepare("SELECT * FROM app_user WHERE email = ?")
      .get(row.values.email);
    const user =
      existing ??
      insert("app_user", {
        email: row.values.email,
        name: row.values.name,
        password_hash: "",
        auth_status: "invited",
        must_change_password: 1,
      });
    const membership = db()
      .prepare(
        `SELECT id FROM membership
         WHERE tenant_id = ? AND org_id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
      .get(principal.tenantId, principal.orgId, user.id);
    if (membership) continue;
    const inserted = insert("membership", {
      tenant_id: principal.tenantId,
      org_id: principal.orgId,
      user_id: user.id,
      roles: row.values.roles,
      status: "active",
      created_by: principal.userId,
    });
    created.push(inserted.id);
  }
  return created;
}

function applyTransactions(principal, rows) {
  return rows.map(
    (row) =>
      insert("transaction_record", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        kind: row.values.kind,
        amount_minor: row.values.amount_minor,
        occurred_on: row.values.occurred_on,
        memo: row.values.memo,
        status: "draft",
        created_by: principal.userId,
      }).id,
  );
}

function applyAssets(principal, rows) {
  return rows.map(
    (row) =>
      insert("asset", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        asset_no: row.values.asset_no,
        name: row.values.name,
        category: row.values.category,
        quantity: row.values.quantity,
        qr_code: `orbitflow://asset/${row.values.asset_no}`,
        created_by: principal.userId,
      }).id,
  );
}

function applyTasks(principal, rows) {
  return rows.map(
    (row) =>
      insert("task", {
        tenant_id: principal.tenantId,
        org_id: principal.orgId,
        title: row.values.title,
        status: row.values.status,
        priority: row.values.priority,
        due_at: row.values.due_at ?? null,
        created_by: principal.userId,
      }).id,
  );
}

const APPLIERS = {
  members: applyMembers,
  transactions: applyTransactions,
  assets: applyAssets,
  tasks: applyTasks,
};

const view = (job) => ({
  id: job.id,
  kind: job.kind,
  status: job.status,
  total_rows: job.total_rows,
  valid_rows: job.valid_rows,
  error_rows: job.error_rows,
  dry_run: Boolean(job.dry_run),
  report: job.report ? JSON.parse(job.report) : [],
  requested_by: job.requested_by,
  created_at: job.created_at,
});

export function templates(_req, res) {
  res.json({
    kinds: [
      { kind: "members", columns: ["email", "name", "roles", "department"] },
      { kind: "transactions", columns: ["kind", "amount_minor", "occurred_on", "memo"] },
      { kind: "assets", columns: ["asset_no", "name", "category", "quantity"] },
      { kind: "tasks", columns: ["title", "status", "priority", "due_at"] },
    ],
  });
}

export function createImport(req, res) {
  const principal = resolvePrincipal(req);
  const payload = importSchema.parse(req.body);
  principal.require(KINDS[payload.kind].permission);

  if (payload.request_key) {
    const duplicate = listScoped(
      "import_job",
      principal,
      [{ sql: "request_key = ?", params: [payload.request_key] }],
      { limit: 1 },
    )[0];
    if (duplicate) {
      throw new ApiError("IDEMPOTENCY_CONFLICT", "같은 request_key 의 가져오기가 이미 있습니다", {
        import_job_id: duplicate.id,
      });
    }
  }

  const rows = parseCsv(payload.csv);
  const { valid, errors } = validate(payload.kind, rows);

  let appliedIds = [];
  if (!payload.dry_run) {
    if (errors.length > 0) {
      throw new ApiError("VALIDATION_ERROR", "오류 행이 있어 적용할 수 없습니다", {
        error_rows: errors.length,
        first_errors: errors.slice(0, 5),
      });
    }
    appliedIds = APPLIERS[payload.kind](principal, valid);
  }

  const job = insert("import_job", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    kind: payload.kind,
    status: payload.dry_run ? "preview" : "applied",
    total_rows: rows.length,
    valid_rows: valid.length,
    error_rows: errors.length,
    dry_run: payload.dry_run,
    report: JSON.stringify(errors.slice(0, 200)),
    requested_by: principal.userId,
    request_key: payload.request_key ?? null,
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: payload.dry_run ? "import.previewed" : "import.applied",
    resourceType: "import_job",
    resourceId: job.id,
    actorId: principal.userId,
    after: { kind: job.kind, total: job.total_rows, valid: job.valid_rows, errors: job.error_rows },
    requestId: req.requestId,
  });

  res.status(201).json({ ...view(job), applied_ids: appliedIds });
}

export function commitImport(req, res) {
  const principal = resolvePrincipal(req);
  const payload = commitSchema.parse(req.body);
  const job = getScoped("import_job", principal, req.params.jobId, "import job");
  principal.require(KINDS[job.kind].permission);

  if (job.status !== "preview") {
    throw new ApiError("CONFLICT", `이미 처리된 가져오기입니다: ${job.status}`);
  }

  const rows = parseCsv(payload.csv);
  const { valid, errors } = validate(job.kind, rows);
  if (errors.length > 0) {
    throw new ApiError("VALIDATION_ERROR", "오류 행이 있어 적용할 수 없습니다", {
      error_rows: errors.length,
      first_errors: errors.slice(0, 5),
    });
  }

  const appliedIds = APPLIERS[job.kind](principal, valid);

  const updated = update(
    "import_job",
    job.id,
    {
      status: "applied",
      dry_run: 0,
      total_rows: rows.length,
      valid_rows: valid.length,
      error_rows: 0,
      report: JSON.stringify([]),
    },
    principal.userId,
  );

  audit.record({
    tenantId: principal.tenantId,
    action: "import.applied",
    resourceType: "import_job",
    resourceId: job.id,
    actorId: principal.userId,
    after: { kind: job.kind, applied: appliedIds.length },
    requestId: req.requestId,
  });

  res.json({ ...view(updated), applied_ids: appliedIds });
}

export function listImports(req, res) {
  const principal = resolvePrincipal(req);
  const filters = req.query.kind ? [{ sql: "kind = ?", params: [req.query.kind] }] : [];
  const rows = listScoped("import_job", principal, filters, {
    limit: Number(req.query.limit ?? 100),
  });
  res.json({ items: rows.map(view) });
}

export function getImport(req, res) {
  const principal = resolvePrincipal(req);
  const job = getScoped("import_job", principal, req.params.jobId, "import job");
  res.json(view(job));
}
