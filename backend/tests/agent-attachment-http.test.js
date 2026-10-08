import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import { api, createOwnerOrg, startTestServer } from './http.js';

test('attachment HTTP survives a fatal parser exit, then uploads real PDF/DOCX with private ACL intact', {timeout:30000}, async t => {
  const server = await startTestServer();
  try {
    const owner = await createOwnerOrg(server.baseUrl, ['agent','documents','projects']);
    const other = await createOwnerOrg(server.baseUrl, ['agent','documents','projects']);
    const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage().drawText('HTTP_PDF_SENTINEL', {font, size:12});
    const pdfInput = {knowledge_mode:'personal', filename:'report.pdf', mime:'application/pdf', content_base64:Buffer.from(await pdf.save()).toString('base64')};
    const docxInput = {knowledge_mode:'personal', filename:'report.docx', mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content_base64:Buffer.from(zipSync({
      '[Content_Types].xml':strToU8('<Types/>'),
      'word/document.xml':strToU8('<w:document><w:body><w:p><w:r><w:t>HTTP_DOCX_SENTINEL</w:t></w:r></w:p></w:body></w:document>'),
    })).toString('base64')};
    const originalFork = childProcess.fork;
    let parserExit;
    const crash = t.mock.method(childProcess, 'fork', (url, args, options) => {
      const child = originalFork(url, args, {...options, execArgv:[...options.execArgv, '--import',
        'data:text/javascript,' + encodeURIComponent("process.kill(process.pid, 'SIGKILL');") ]});
      child.once('exit', (code, signal) => { parserExit = {code, signal}; });
      return child;
    });
    syncBuiltinESMExports();
    let failed;
    try {
      failed = await api(server.baseUrl, '/agent/attachments', { ...owner, method:'POST', body:pdfInput });
      assert.equal(failed.status, 422, JSON.stringify(failed.body));
      assert.equal(failed.body.error.code, 'DOCUMENT_PARSE_FAILED');
      assert.ok(parserExit, 'HTTP failure must await the parser exit');
    } finally { crash.mock.restore(); syncBuiltinESMExports(); }
    const uploads = await Promise.all([pdfInput, docxInput].map(body => api(server.baseUrl, '/agent/attachments', {...owner, method:'POST', body})));
    for (const [i, response] of uploads.entries()) {
      assert.equal(response.status, 201, JSON.stringify(response.body));
      assert.equal(response.body.filename, [pdfInput, docxInput][i].filename);
      assert.equal(response.body.text_length, ['HTTP_PDF_SENTINEL','HTTP_DOCX_SENTINEL'][i].length);
      const route = `/agent/attachments/${response.body.id}`;
      const denied = await api(server.baseUrl, route + '?knowledge_mode=personal', other);
      assert.equal(denied.status, 404);
      assert.equal((await api(server.baseUrl, route + '?knowledge_mode=company', owner)).status, 404);
      const download = await api(server.baseUrl, route + '/download?knowledge_mode=personal&encoding=base64', owner);
      assert.equal(download.status, 200);
      assert.equal(download.body.content_base64, [pdfInput, docxInput][i].content_base64);
    }
    t.diagnostic(JSON.stringify({parserExit, failureStatus:failed.status, recoveryStatuses:uploads.map(value => value.status), privateACL:404, byteExactDownloads:true}));
  } finally { await server.close(); }
});
