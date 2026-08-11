import { z } from "zod";

import { resolvePrincipal } from "../middleware/auth.js";
import { getScoped, insert, listScoped, update } from "../models/base.js";
import * as audit from "../services/audit.service.js";
import { notify } from "../services/notification.service.js";
import { ApiError } from "../utils/errors.js";

const STEP_KINDS = ["notify", "create_task", "webhook", "delay", "branch"];

const stepSchema = z.object({
  kind: z.enum(["notify", "create_task", "webhook", "delay", "branch"]),
  config: z.record(z.any()).default({}),
  when: z.string().nullable().optional(),
});

const workflowSchema = z.object({
  name: z.string().min(1).max(200),
  trigger_type: z.enum(["manual", "schedule", "event"]).default("manual"),
  trigger_config: z.record(z.any()).default({}),
  definition: z.object({ steps: z.array(stepSchema).min(1) }),
});

const versionSchema = z.object({
  definition: z.object({ steps: z.array(stepSchema).min(1) }),
});

const runSchema = z.object({
  input: z.record(z.any()).default({}),
  sandbox: z.boolean().default(false),
});

const workflowView = (w) => ({
  id: w.id,
  name: w.name,
  trigger_type: w.trigger_type,
  trigger_config: JSON.parse(w.trigger_config || "{}"),
  status: w.status,
  active_revision: w.active_revision,
  version: w.version,
});

const runView = (r) => ({
  id: r.id,
  workflow_id: r.workflow_id,
  revision: r.revision,
  status: r.status,
  input: JSON.parse(r.input_json || "{}"),
  output: JSON.parse(r.output_json || "{}"),
  failed_step: r.failed_step,
  sandbox: Boolean(r.sandbox),
  triggered_by: r.triggered_by,
  started_at: r.created_at,
  finished_at: r.finished_at,
});

function latestRevision(principal, workflowId) {
  const versions = listScoped("workflow_version", principal, [
    { sql: "workflow_id = ?", params: [workflowId] },
  ], { orderBy: "revision DESC", limit: 1 });
  return versions[0]?.revision ?? 0;
}

function activeDefinition(principal, workflow) {
  if (workflow.active_revision < 1) {
    throw new ApiError("CONFLICT", "발행된 버전이 없습니다. 먼저 버전을 발행하세요.", {
      workflow_id: workflow.id,
    });
  }
  const version = listScoped("workflow_version", principal, [
    { sql: "workflow_id = ?", params: [workflow.id] },
    { sql: "revision = ?", params: [workflow.active_revision] },
  ], { limit: 1 })[0];
  if (!version) throw new ApiError("NOT_FOUND", "workflow version not found");
  return { version, definition: JSON.parse(version.definition || "{}") };
}

function conditionHolds(when, context) {
  if (!when) return true;
  const [left, right] = when.split("==").map((part) => part.trim());
  if (right === undefined) return Boolean(context[left]);
  const actual = context[left];
  return String(actual ?? "") === right.replace(/^["']|["']$/g, "");
}

function runStep(principal, step, context, sandbox) {
  if (sandbox) return { simulated: true, kind: step.kind, config: step.config };

  if (step.kind === "notify") {
    const created = notify({
      tenantId: principal.tenantId,
      recipientId: step.config.recipient_id ?? principal.userId,
      type: "automation.notify",
      title: String(step.config.title ?? "자동화 알림"),
      body: String(step.config.body ?? ""),
    });
    return { notification_id: created?.id ?? null };
  }

  if (step.kind === "create_task") {
    const task = insert("task", {
      tenant_id: principal.tenantId,
      org_id: principal.orgId,
      project_id: step.config.project_id ?? null,
      title: String(step.config.title ?? "자동 생성 업무"),
      description: String(step.config.description ?? ""),
      assignee_id: step.config.assignee_id ?? null,
      priority: String(step.config.priority ?? "normal"),
      due_at: step.config.due_at ?? null,
      created_by: principal.userId,
    });
    return { task_id: task.id };
  }

  if (step.kind === "webhook") {
    const delivery = insert("webhook_delivery", {
      tenant_id: principal.tenantId,
      endpoint_id: String(step.config.endpoint_id ?? ""),
      event: String(step.config.event ?? "automation.step"),
      payload: JSON.stringify({ ...step.config.payload, context }),
      created_by: principal.userId,
    });
    return { delivery_id: delivery.id, status: "queued" };
  }

  if (step.kind === "delay") {
    return { deferred_seconds: Number(step.config.seconds ?? 0) };
  }

  return { branch: conditionHolds(step.when, context) };
}

export function createWorkflow(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("automation.manage");
  const payload = workflowSchema.parse(req.body);

  const workflow = insert("workflow", {
    tenant_id: principal.tenantId,
    org_id: principal.orgId,
    name: payload.name,
    trigger_type: payload.trigger_type,
    trigger_config: JSON.stringify(payload.trigger_config),
    created_by: principal.userId,
  });

  insert("workflow_version", {
    tenant_id: principal.tenantId,
    workflow_id: workflow.id,
    revision: 1,
    definition: JSON.stringify(payload.definition),
    created_by: principal.userId,
  });

  audit.record({
    tenantId: principal.tenantId,
    action: "workflow.created",
    resourceType: "workflow",
    resourceId: workflow.id,
    actorId: principal.userId,
    after: { name: workflow.name, trigger_type: workflow.trigger_type },
    requestId: req.requestId,
  });

  res.status(201).json({ ...workflowView(workflow), draft_revision: 1 });
}

export function listWorkflows(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("automation.manage");
  const filters = req.query.status ? [{ sql: "status = ?", params: [req.query.status] }] : [];
  const rows = listScoped("workflow", principal, filters, { limit: Number(req.query.limit ?? 100) });
  res.json({ items: rows.map(workflowView), step_kinds: STEP_KINDS });
}

export function getWorkflow(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("automation.manage");
  const workflow = getScoped("workflow", principal, req.params.workflowId, "workflow");
  const versions = listScoped("workflow_version", principal, [
    { sql: "workflow_id = ?", params: [workflow.id] },
  ], { orderBy: "revision DESC", limit: 50 });

  res.json({
    ...workflowView(workflow),
    versions: versions.map((v) => ({
      revision: v.revision,
      status: v.status,
      published_at: v.published_at,
      definition: JSON.parse(v.definition || "{}"),
    })),
  });
}

export function addVersion(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("automation.manage");
  const workflow = getScoped("workflow", principal, req.params.workflowId, "workflow");
  const payload = versionSchema.parse(req.body);

  const revision = latestRevision(principal, workflow.id) + 1;
  const version = insert("workflow_version", {
    tenant_id: principal.tenantId,
    workflow_id: workflow.id,
    revision,
    definition: JSON.stringify(payload.definition),
    created_by: principal.userId,
  });

  res.status(201).json({
    workflow_id: workflow.id,
    revision: version.revision,
    status: version.status,
  });
}

export function publishWorkflow(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("automation.manage");
  const workflow = getScoped("workflow", principal, req.params.workflowId, "workflow");
  const revision = Number(req.body?.revision ?? latestRevision(principal, workflow.id));

  const version = listScoped("workflow_version", principal, [
    { sql: "workflow_id = ?", params: [workflow.id] },
    { sql: "revision = ?", params: [revision] },
  ], { limit: 1 })[0];
  if (!version) throw new ApiError("NOT_FOUND", "workflow version not found");

  update("workflow_version", version.id, {
    status: "published",
    published_at: new Date().toISOString(),
  }, principal.userId);
  const updated = update("workflow", workflow.id, {
    status: "active",
    active_revision: revision,
  }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "workflow.published",
    resourceType: "workflow",
    resourceId: workflow.id,
    actorId: principal.userId,
    before: { active_revision: workflow.active_revision },
    after: { active_revision: revision },
    requestId: req.requestId,
  });

  res.json(workflowView(updated));
}

export function disableWorkflow(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("automation.manage");
  const workflow = getScoped("workflow", principal, req.params.workflowId, "workflow");
  const updated = update("workflow", workflow.id, { status: "disabled" }, principal.userId);
  res.json(workflowView(updated));
}

export function runWorkflow(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("automation.manage");
  const workflow = getScoped("workflow", principal, req.params.workflowId, "workflow");
  const payload = runSchema.parse(req.body ?? {});
  const { definition } = activeDefinition(principal, workflow);

  const run = insert("workflow_run", {
    tenant_id: principal.tenantId,
    workflow_id: workflow.id,
    revision: workflow.active_revision,
    input_json: JSON.stringify(payload.input),
    request_id: req.requestId ?? null,
    triggered_by: principal.userId,
    sandbox: payload.sandbox,
    created_by: principal.userId,
  });

  const context = { ...payload.input };
  const outputs = [];
  let failedStep = null;
  let error = null;

  definition.steps.forEach((step, ordinal) => {
    if (failedStep !== null) return;
    if (!conditionHolds(step.when, context)) {
      insert("workflow_step_run", {
        tenant_id: principal.tenantId,
        run_id: run.id,
        ordinal,
        kind: step.kind,
        status: "skipped",
        input_json: JSON.stringify(step.config ?? {}),
        created_by: principal.userId,
      });
      outputs.push({ ordinal, kind: step.kind, status: "skipped" });
      return;
    }
    try {
      const output = runStep(principal, step, context, payload.sandbox);
      Object.assign(context, output);
      insert("workflow_step_run", {
        tenant_id: principal.tenantId,
        run_id: run.id,
        ordinal,
        kind: step.kind,
        status: "ok",
        input_json: JSON.stringify(step.config ?? {}),
        output_json: JSON.stringify(output),
        created_by: principal.userId,
      });
      outputs.push({ ordinal, kind: step.kind, status: "ok", output });
    } catch (stepError) {
      failedStep = ordinal;
      error = stepError.message;
      insert("workflow_step_run", {
        tenant_id: principal.tenantId,
        run_id: run.id,
        ordinal,
        kind: step.kind,
        status: "failed",
        input_json: JSON.stringify(step.config ?? {}),
        error: stepError.message,
        created_by: principal.userId,
      });
      outputs.push({ ordinal, kind: step.kind, status: "failed", error: stepError.message });
    }
  });

  const finished = update("workflow_run", run.id, {
    status: failedStep === null ? "succeeded" : "failed",
    output_json: JSON.stringify({ steps: outputs, error }),
    failed_step: failedStep,
    finished_at: new Date().toISOString(),
  }, principal.userId);

  audit.record({
    tenantId: principal.tenantId,
    action: "workflow.run",
    resourceType: "workflow_run",
    resourceId: run.id,
    actorId: principal.userId,
    after: { status: finished.status, sandbox: payload.sandbox },
    requestId: req.requestId,
  });

  res.status(failedStep === null ? 200 : 207).json({ ...runView(finished), steps: outputs });
}

export function listRuns(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("automation.manage");
  const filters = req.query.workflow_id
    ? [{ sql: "workflow_id = ?", params: [req.query.workflow_id] }]
    : [];
  const rows = listScoped("workflow_run", principal, filters, {
    limit: Number(req.query.limit ?? 50),
  });
  res.json({ items: rows.map(runView) });
}

export function getRun(req, res) {
  const principal = resolvePrincipal(req);
  principal.require("automation.manage");
  const run = getScoped("workflow_run", principal, req.params.runId, "workflow_run");
  const steps = listScoped("workflow_step_run", principal, [
    { sql: "run_id = ?", params: [run.id] },
  ], { orderBy: "ordinal ASC", limit: 200 });

  res.json({
    ...runView(run),
    steps: steps.map((s) => ({
      ordinal: s.ordinal,
      kind: s.kind,
      status: s.status,
      input: JSON.parse(s.input_json || "{}"),
      output: JSON.parse(s.output_json || "{}"),
      error: s.error,
    })),
  });
}
