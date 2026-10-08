import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertConversationKnowledgeMode, strongestClassification, containsCredentials } from '../src/services/agent-knowledge-policy.service.js';
import { extractAttachmentText } from '../src/services/agent-attachments.service.js';

test('knowledge policy is conservative about mode, classification and credentials', () => {
  assert.throws(() => assertConversationKnowledgeMode({}, 'company'), {code:'KNOWLEDGE_MODE_MISMATCH'});
  assertConversationKnowledgeMode({}, 'personal');
  assert.equal(strongestClassification(['public','unknown','internal']), 'confidential');
  assert.equal(containsCredentials('api_key = sk-synthetic-value'), true);
  assert.equal(containsCredentials('{"password":"synthetic-value"}'), true);
  assert.equal(containsCredentials('We decided to deliver reports on Fridays.'), false);
});

test('attachment parser rejects paths, unsupported media and empty evidence', async () => {
  const text = value => ({filename:'a.txt',mime:'text/plain',content_base64:Buffer.from(value).toString('base64')});
  assert.equal((await extractAttachmentText(text('Friday report requirement'))).text, 'Friday report requirement');
  await assert.rejects(extractAttachmentText({...text('hello'),filename:'../a.txt'}), {code:'VALIDATION_ERROR'});
  await assert.rejects(extractAttachmentText({...text('hello'),filename:'x.exe'}), {code:'UNSUPPORTED_MEDIA_TYPE'});
  await assert.rejects(extractAttachmentText(text('   ')), {code:'DOCUMENT_NO_TEXT'});
  await assert.rejects(extractAttachmentText({...text('hello'),filename:'dir'+String.fromCharCode(92)+'a.txt'}), {code:'VALIDATION_ERROR'});
  await assert.rejects(extractAttachmentText({...text('hello'),content_base64:'aGVsbG8'}), {code:'VALIDATION_ERROR'});
});

test('real PDF extraction, no-text PDF, bounded DOCX and hostile archive', {timeout:30000}, async () => {
  const {PDFDocument,StandardFonts}=await import('pdf-lib');
  const {zipSync,strToU8}=await import('fflate');
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('PDF_KNOWLEDGE_SENTINEL Friday reports',{font,size:12});
  const input={filename:'report.pdf',mime:'application/pdf',content_base64:Buffer.from(await pdf.save()).toString('base64')};
  assert.ok((await extractAttachmentText(input)).text.includes('PDF_KNOWLEDGE_SENTINEL'));
  const blank=await PDFDocument.create();blank.addPage();
  await assert.rejects(extractAttachmentText({...input,content_base64:Buffer.from(await blank.save()).toString('base64')}),{code:'DOCUMENT_NO_TEXT'});
  const xml='<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>DOCX_KNOWLEDGE_SENTINEL &amp; Friday</w:t></w:r></w:p></w:body></w:document>';
  const docx=entries=>({filename:'report.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',content_base64:Buffer.from(zipSync(entries)).toString('base64')});
  const entries={'[Content_Types].xml':strToU8('<Types/>'),'word/document.xml':strToU8(xml)};
  assert.equal((await extractAttachmentText(docx(entries))).text,'DOCX_KNOWLEDGE_SENTINEL & Friday');
  await assert.rejects(extractAttachmentText(docx({...entries,'../evil':strToU8('evil')})),{code:'DOCUMENT_LIMIT_EXCEEDED'});
  await assert.rejects(extractAttachmentText(docx({...entries,'huge.txt':strToU8('x'.repeat(2000001))})),{code:'DOCUMENT_LIMIT_EXCEEDED'});
  await assert.rejects(extractAttachmentText(docx({...entries,'word/document.xml':strToU8('<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///private">]>'+xml)})),{code:'DOCUMENT_PARSE_FAILED'});
});
