import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { zipSync, strToU8 } from 'fflate';
import { extractAttachmentText } from '../src/services/agent-attachments.service.js';

for (const mode of ['kill', 'exit', 'result-exit', 'secret-error', 'hang']) {
  test(`document parser contains ${mode} and awaits child exit without leaking secrets`, {timeout:20000}, async t => {
    const supervisor = fork(new URL('./fixtures/agent-parser-exit-supervisor.mjs', import.meta.url), [mode], {
      execArgv:[], stdio:['ignore','pipe','pipe','ipc'], windowsHide:true,
    });
    const closed = once(supervisor, 'close', {signal:AbortSignal.timeout(15000)});
    let stdout = '', stderr = '', result;
    supervisor.stdout.on('data', chunk => { stdout += chunk; });
    supervisor.stderr.on('data', chunk => { stderr += chunk; });
    supervisor.on('message', message => { result = message; });
    try {
      const [code, signal] = await closed;
      assert.deepEqual({code, signal}, {code:0, signal:null}, `supervisor died or failed: ${stderr}`);
      assert.equal(result?.parentAlive, true);
      assert.equal(result.exits.length, 1);
      if (['exit','result-exit'].includes(mode)) assert.deepEqual(result.exits[0], {code:23, signal:null});
      if (mode === 'hang') assert.equal(result.exits[0].signal, 'SIGKILL');
      assert.ok(!stdout.includes('SYNTHETIC_PARSER_SECRET'));
      assert.ok(!stderr.includes('SYNTHETIC_PARSER_SECRET'));
      t.diagnostic(JSON.stringify(result));
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        supervisor.kill('SIGKILL');
        await once(supervisor, 'close', {signal:AbortSignal.timeout(5000)});
      }
    }
  });
}

test('real PDF and DOCX parse concurrently with page, archive and byte bounds intact', {timeout:30000}, async () => {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage().drawText('PARALLEL_PDF_SENTINEL', {font, size:12});
  const pdfInput = {filename:'report.pdf', mime:'application/pdf', content_base64:Buffer.from(await pdf.save()).toString('base64')};
  const entries = {'[Content_Types].xml':strToU8('<Types/>'), 'word/document.xml':strToU8('<w:document><w:body><w:p><w:r><w:t>PARALLEL_DOCX_SENTINEL</w:t></w:r></w:p></w:body></w:document>')};
  const docx = files => ({filename:'report.docx', mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', content_base64:Buffer.from(zipSync(files)).toString('base64')});
  const results = await Promise.all(Array.from({length:6}, (_, i) => extractAttachmentText(i % 2 ? docx(entries) : pdfInput)));
  assert.deepEqual(results.map(result => result.text.trim()), Array.from({length:6}, (_, i) => i % 2 ? 'PARALLEL_DOCX_SENTINEL' : 'PARALLEL_PDF_SENTINEL'));
  const large = await PDFDocument.create();
  for (let i = 0; i < 51; i++) large.addPage();
  await assert.rejects(extractAttachmentText({...pdfInput, content_base64:Buffer.from(await large.save()).toString('base64')}), {code:'DOCUMENT_LIMIT_EXCEEDED'});
  const excessEntries = {...entries, ...Object.fromEntries(Array.from({length:127}, (_, i) => [`extra${i}`, strToU8('x')]))};
  await assert.rejects(extractAttachmentText(docx(excessEntries)), {code:'DOCUMENT_LIMIT_EXCEEDED'});
  const excessArchive = {...entries, ...Object.fromEntries(Array.from({length:5}, (_, i) => [`extra${i}`, strToU8('x'.repeat(1700000))]))};
  await assert.rejects(extractAttachmentText(docx(excessArchive)), {code:'DOCUMENT_LIMIT_EXCEEDED'});
  await assert.rejects(extractAttachmentText({...pdfInput, content_base64:Buffer.alloc(1000001).toString('base64')}), {code:'VALIDATION_ERROR'});
});
