import { z } from 'zod';
import { ApiError, notFound } from '../utils/errors.js';
import { allowedSensitivity, SENSITIVITY_RANK } from './rag.service.js';

const id = z.string().regex(/^[1-9]\d*$/);
export const pgDocumentCreateInput = z.object({
  title: z.string().trim().min(1).max(300), content_md: z.string().default(''),
  project_id: id.nullable().optional(), file_id: id.nullable().optional(),
  sensitivity: z.enum(['public','internal','personal','sensitive','confidential']).default('internal'),
  visibility: z.enum(['org','private','public']).default('org'),
  ai_generated: z.boolean().default(false), review_status: z.enum(['unreviewed','reviewed']).default('reviewed'),
}).strict();
export const pgDocumentPatchInput = z.object({
  title: z.string().trim().min(1).max(300).optional(), content: z.string().optional(),
  version: z.number().int().positive(),
}).strict().refine(value => value.title !== undefined || value.content !== undefined);

export function toPgDocument(row) {
  return { ...row, id: String(row.id), company_id: String(row.company_id),
    project_id: row.project_id == null ? null : String(row.project_id),
    owner_id: row.owner_id == null ? null : String(row.owner_id),
    author_id: row.author_id == null ? null : String(row.author_id),
    file_id: row.file_id == null ? null : String(row.file_id),
    content: row.content_md ?? '', content_md: row.content_md ?? '', version: Number(row.version),
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at };
}

export function canReadPgDocumentRestrictions(principal, row, knowledgeMode) {
  return Object.hasOwn(SENSITIVITY_RANK,row.sensitivity) && SENSITIVITY_RANK[row.sensitivity] <= allowedSensitivity(principal)
    && (row.visibility !== 'private' || String(row.owner_id) === String(principal.userId))
    && ((knowledgeMode ?? principal.knowledgeMode) !== 'company' || (row.visibility !== 'private' && row.sensitivity !== 'personal'));
}
export function pgDocumentReadScope(principal, knowledgeMode) {
  return { sql: `d.company_id=$1 AND NOT d.archived AND d.deleted_at IS NULL
    AND (d.visibility<>'private' OR d.owner_id=$2)
    AND (CASE d.sensitivity WHEN 'public' THEN 0 WHEN 'internal' THEN 1 WHEN 'personal' THEN 2 WHEN 'sensitive' THEN 3 WHEN 'confidential' THEN 4 ELSE 5 END)<=$3
    AND ($4::text IS DISTINCT FROM 'company' OR (d.visibility<>'private' AND d.sensitivity<>'personal'))`,
  values: [principal.companyId, principal.userId, allowedSensitivity(principal), knowledgeMode ?? principal.knowledgeMode ?? null] };
}

// Callers supply their already-authorized company principal and transaction/query client.
// Filtering precedes LIMIT and body projection; no private or over-classified row leaves this adapter.
export async function listPgDocuments(client, principal, options = {}) {
  const scope = pgDocumentReadScope(principal, options.knowledgeMode);
  if (options.projectId) { scope.values.push(id.parse(String(options.projectId))); scope.sql += ` AND d.project_id=$${scope.values.length}`; }
  if (options.query) { scope.values.push(`%${options.query}%`); scope.sql += ` AND d.title ILIKE $${scope.values.length}`; }
  const limit = options.limit === undefined ? '' : ` LIMIT $${scope.values.push(z.number().int().positive().parse(options.limit))}`;
  return (await client.query(`SELECT d.* FROM workspace.document_catalog d WHERE ${scope.sql} ORDER BY d.updated_at DESC,d.id${limit}`,scope.values)).rows.map(toPgDocument);
}
export async function getPgDocument(client, principal, documentId, options = {}) {
  const scope = pgDocumentReadScope(principal, options.knowledgeMode);
  scope.values.push(id.parse(String(documentId)));
  const sql = `SELECT d.* FROM workspace.document_catalog d WHERE ${scope.sql} AND d.id=$5`;
  let row = (await client.query(sql,scope.values)).rows[0];
  if (row && options.lock) {
    // UNION views cannot be row-locked. Lock the native source, then recheck visibility.
    await client.query(`SELECT id FROM ${row.storage === 'workspace' ? 'workspace.documents' : 'project.documents'} WHERE id=$1 FOR UPDATE`,[row.id]);
    row = (await client.query(sql,scope.values)).rows[0];
  }
  return row ? toPgDocument(row) : null;
}
async function snapshot(client, row, actorId) {
  await client.query(`INSERT INTO workspace.document_versions(document_id,revision,title,content,author_id,sensitivity,visibility)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(document_id,revision) DO NOTHING`,
  [row.id,row.version,row.title,row.content,actorId,row.sensitivity,row.visibility]);
}
async function indexDocument(client, row) {
  await client.query('DELETE FROM workspace.document_chunks WHERE document_id=$1',[row.id]);
  const parts = row.content.split('\n\n').map(part => part.trim()).filter(Boolean);
  await client.query(`INSERT INTO workspace.document_chunks(document_id,ordinal,version,content,sensitivity,visibility)
    SELECT $1,(ordinality-1)::integer,$2,left(content,4000),$3,$4 FROM unnest($5::text[]) WITH ORDINALITY AS part(content,ordinality)`,
  [row.id,row.version,row.sensitivity,row.visibility,parts.length ? parts : [row.title]]);
}
async function auditDocument(client, principal, row, action) {
  // Company-wide audit never receives document bodies, including private/protected creates.
  await client.query(`INSERT INTO org.daily_correction_events(company_id,actor_id,resource_type,resource_id,action,before_data,after_data)
    VALUES($1,$2,'documents',$3,$4,'{}'::jsonb,$5::jsonb)`,
  [principal.companyId,principal.userId,row.id,action,JSON.stringify({title:row.title})]);
}
export async function createPgDocument(client, principal, input) {
  const body = pgDocumentCreateInput.parse(input);
  if (principal.knowledgeMode === 'company' && (body.visibility === 'private' || body.sensitivity === 'personal')) throw new ApiError('PERMISSION_DENIED','Company mode excludes personal documents.');
  if (body.project_id && !(await client.query('SELECT id FROM project.projects WHERE id=$1 AND company_id=$2 FOR SHARE',[body.project_id,principal.companyId])).rows[0]) throw new ApiError('VALIDATION_ERROR','Invalid project for selected company.');
  if (body.file_id && !(await client.query('SELECT id FROM files.objects WHERE id=$1 AND company_id=$2 FOR SHARE',[body.file_id,principal.companyId])).rows[0]) throw notFound('file');
  const stored = (await client.query(`INSERT INTO workspace.documents(company_id,project_id,title,content_md,file_id,author_id,owner_id,sensitivity,visibility,ai_generated,review_status)
    VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10) RETURNING *`,
  [principal.companyId,body.project_id ?? null,body.title,body.content_md,body.file_id ?? null,principal.userId,body.sensitivity,body.visibility,body.ai_generated,body.review_status])).rows[0];
  const row = toPgDocument({...stored,storage:'workspace',project_name:body.project_id ? (await client.query('SELECT name FROM project.projects WHERE id=$1',[body.project_id])).rows[0].name : null});
  await snapshot(client,row,principal.userId);
  await indexDocument(client,row);
  await auditDocument(client,principal,row,'created');
  return row;
}
export async function patchPgDocument(client, principal, documentId, input) {
  const body = pgDocumentPatchInput.parse(input);
  const before = await getPgDocument(client,principal,documentId,{lock:true});
  if (!before) throw notFound('document');
  if (before.version !== body.version) throw new ApiError('VERSION_CONFLICT','Document changed.');
  await snapshot(client,before,before.author_id);
  const table = before.storage === 'workspace' ? 'workspace.documents' : 'project.documents';
  const updated = (await client.query(`UPDATE ${table} SET title=COALESCE($2,title),content_md=COALESCE($3,content_md),version=version+1,updated_at=now() WHERE id=$1 AND version=$4 RETURNING *`,
  [before.id,body.title ?? null,body.content ?? null,body.version])).rows[0];
  if (!updated) throw new ApiError('VERSION_CONFLICT','Document changed.');
  const row = toPgDocument({...before,...updated});
  await snapshot(client,row,principal.userId);
  await indexDocument(client,row);
  await auditDocument(client,principal,row,'updated');
  return row;
}
export async function pgDocumentVersions(client, principal, documentId) {
  const row = await getPgDocument(client,principal,documentId);
  if (!row) throw notFound('document');
  const versions = (await client.query('SELECT revision,author_id,created_at FROM workspace.document_versions WHERE document_id=$1 ORDER BY revision DESC',[row.id])).rows;
  return versions.length ? versions : [{revision:row.version,author_id:row.author_id,created_at:row.updated_at}];
}
export async function deletePgDocument(client, principal, documentId) {
  const row = await getPgDocument(client,principal,documentId,{lock:true});
  if (!row) throw notFound('document');
  if (row.storage === 'workspace') await client.query('UPDATE workspace.documents SET deleted_at=now(),updated_at=now(),version=version+1 WHERE id=$1',[row.id]);
  else await client.query('DELETE FROM project.documents WHERE id=$1',[row.id]);
  await client.query('DELETE FROM workspace.document_chunks WHERE document_id=$1',[row.id]);
  await auditDocument(client,principal,row,'deleted');
}
