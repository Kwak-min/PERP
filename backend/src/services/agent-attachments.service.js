import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { z } from 'zod';
import { knowledgeTransaction, requireKnowledgeAccess, scopedKnowledgeArgs, SCOPED_KNOWLEDGE_WHERE } from './agent-knowledge-store.service.js';
import { failKnowledge, hashKnowledge, containsCredentials, strongestClassification, contextIdentity } from './agent-knowledge-policy.service.js';

export const attachmentInputSchema = z.object({filename:z.string().min(1).max(255),mime:z.string().max(120),content_base64:z.string().min(1).max(1333336),classification:z.enum(['public','internal','personal','sensitive','confidential']).optional()}).strict();
const formats = {txt:['text/plain'],md:['text/markdown','text/plain'],pdf:['application/pdf'],docx:['application/vnd.openxmlformats-officedocument.wordprocessingml.document']};
export async function extractAttachmentText(input) {
  const parsed = attachmentInputSchema.safeParse(input);
  if (!parsed.success) failKnowledge('VALIDATION_ERROR');
  const {filename,mime,content_base64} = parsed.data;
  if (/[\/\u0000-\u001f\u007f:]/.test(filename) || filename.includes(String.fromCharCode(92)) || filename === '.' || filename === '..') failKnowledge('VALIDATION_ERROR');
  const extension = filename.split('.').at(-1).toLowerCase();
  if (!formats[extension]?.includes(mime.toLowerCase())) failKnowledge('UNSUPPORTED_MEDIA_TYPE',415);
  const bytes = Buffer.from(content_base64,'base64');
  if (!bytes.length || bytes.length > 1000000 || bytes.toString('base64') !== content_base64) failKnowledge('VALIDATION_ERROR');
  let text;
  if (['txt','md'].includes(extension)) {
    try { text = new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
    catch { failKnowledge('DOCUMENT_PARSE_FAILED',422); }
    if (text.includes(String.fromCharCode(0))) failKnowledge('DOCUMENT_PARSE_FAILED',422);
  } else {
    if (extension === 'pdf' ? !bytes.subarray(0,5).equals(Buffer.from('%PDF-')) : !bytes.subarray(0,2).equals(Buffer.from('PK'))) failKnowledge('DOCUMENT_PARSE_FAILED',422);
    try {
      // 네이티브 PDF 파서의 process 종료를 격리한다. 비밀 환경 변수와 Node preload는 상속하지 않는다.
      const parserEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['systemroot','windir'].includes(key.toLowerCase())));
      const child = fork(new URL('./agent-attachment-parser.worker.js',import.meta.url), [], {
        execPath:process.execPath, execArgv:['--max-old-space-size=128'], env:parserEnv,
        shell:false, windowsHide:true, serialization:'advanced', stdio:['ignore','ignore','ignore','ipc'],
      });
      text = await new Promise((resolve,reject) => {
        let result, failure;
        const stop = code => { failure ??= code; child.kill('SIGKILL'); };
        const timeout = setTimeout(() => stop('DOCUMENT_PARSE_TIMEOUT'),8000);
        // 결과 메시지 뒤 네이티브 정리 중 종료될 수도 있으므로 실제 종료까지 기다린다.
        child.once('message', message => {
          if (['DOCUMENT_LIMIT_EXCEEDED','DOCUMENT_PARSE_FAILED'].includes(message?.code)
            || typeof message?.text === 'string' && message.text.length <= 100000 && !message.code) result = message;
          else stop('DOCUMENT_PARSE_FAILED');
        });
        child.once('error', () => { failure ??= 'DOCUMENT_PARSE_FAILED'; });
        child.once('close', (code,signal) => {
          clearTimeout(timeout);
          const error = failure ?? (code !== 0 || signal || !result ? 'DOCUMENT_PARSE_FAILED' : result.code);
          error ? reject(new Error(error)) : resolve(result.text);
        });
        child.send({bytes,extension}, error => { if (error) stop('DOCUMENT_PARSE_FAILED'); });
      });
    } catch (error) {
      failKnowledge(['DOCUMENT_LIMIT_EXCEEDED','DOCUMENT_PARSE_TIMEOUT'].includes(error.message) ? error.message : 'DOCUMENT_PARSE_FAILED',422);
    }
  }
  if (!text.trim()) failKnowledge('DOCUMENT_NO_TEXT',422);
  if (text.length > 100000) failKnowledge('DOCUMENT_LIMIT_EXCEEDED',413);
  return {bytes,text,filename,mime:mime.toLowerCase()};
}

function attachmentView(row, context) {
  return {id:row.id,filename:row.filename,mime:row.mime,size:Number(row.size),knowledge_mode:row.knowledge_mode,
    classification:row.classification,text_length:row.extracted_text.length,content_hash:row.content_hash,
    download_url:`/api/v1/${context.source === 'pg' ? 'pg/' : ''}agent/attachments/${row.id}/download?knowledge_mode=${row.knowledge_mode}`};
}
export async function createAttachment(context,input) {
  contextIdentity(context);
  await knowledgeTransaction(context,function*(tx) {requireKnowledgeAccess(tx.p,context.knowledgeMode,true);});
  const extracted = await extractAttachmentText(input);
  const classification = strongestClassification([input.classification ?? (context.knowledgeMode === 'personal' ? 'personal' : 'internal'),containsCredentials(extracted.filename+' '+extracted.text) ? 'sensitive' : 'public']);
  return knowledgeTransaction(context,function*(tx) {
    requireKnowledgeAccess(tx.p,context.knowledgeMode,true);
    const scope = scopedKnowledgeArgs(context), id = randomUUID();
    const row = {id,filename:extracted.filename,mime:extracted.mime,size:extracted.bytes.length,knowledge_mode:context.knowledgeMode,extracted_text:extracted.text,classification,content_hash:hashKnowledge(extracted.text)};
    yield tx.query(`INSERT INTO agent_knowledge_attachment(id,tenant_id,workspace_id,actor_id,knowledge_mode,filename,mime,size,content_base64,extracted_text,content_hash,classification,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id,...scope,row.filename,row.mime,row.size,extracted.bytes.toString('base64'),row.extracted_text,row.content_hash,classification,new Date().toISOString()]);
    return attachmentView(row,context);
  });
}
export function* readAttachmentRow(tx,context,id) {
  if (!z.string().uuid().safeParse(id).success) failKnowledge('NOT_FOUND',404);
  requireKnowledgeAccess(tx.p,context.knowledgeMode);
  const row = (yield tx.query(`SELECT * FROM agent_knowledge_attachment WHERE ${SCOPED_KNOWLEDGE_WHERE} AND id=?`,[...scopedKnowledgeArgs(context),id]))[0];
  if (!row) failKnowledge('NOT_FOUND',404);
  return row;
}
export async function getAttachment(context,id) {return knowledgeTransaction(context,function*(tx) {return attachmentView(yield* readAttachmentRow(tx,context,id),context);});}
export async function downloadAttachment(context,id) {return knowledgeTransaction(context,function*(tx) {const row = yield* readAttachmentRow(tx,context,id); return {bytes:Buffer.from(row.content_base64,'base64'),filename:row.filename,mime:row.mime};});}
export async function deleteAttachment(context,id) {return knowledgeTransaction(context,function*(tx) {yield* readAttachmentRow(tx,context,id);requireKnowledgeAccess(tx.p,context.knowledgeMode,true);yield tx.query('DELETE FROM agent_knowledge_attachment WHERE id=?',[id]);return {id,deleted:true};});}
