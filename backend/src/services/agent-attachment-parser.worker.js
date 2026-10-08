import { unzipSync, strFromU8 } from 'fflate';

async function extract({bytes, extension}) {
  if (extension === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useWorkerFetch:false,disableFontFace:true,verbosity:0});
    let document;
    try {
      document = await loading.promise;
      if (document.numPages > 50) throw new Error('DOCUMENT_LIMIT_EXCEEDED');
      let text = '';
      for (let i = 1; i <= document.numPages; i++) {
        const page = await document.getPage(i), content = await page.getTextContent();
        text += content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('') + '\n';
        if (text.length > 100000) throw new Error('DOCUMENT_LIMIT_EXCEEDED');
        page.cleanup();
      }
      return text.trim();
    } finally { if (document) await document.destroy(); else await loading.destroy(); }
  }
  let count = 0, total = 0;
  const files = unzipSync(new Uint8Array(bytes), {filter:entry => {
    count++; total += entry.originalSize;
    if (count > 128 || total > 8000000 || entry.originalSize > 2000000 || entry.name.startsWith('/') || entry.name.includes('..') || entry.name.includes(':') || entry.name.includes(String.fromCharCode(92))) throw new Error('DOCUMENT_LIMIT_EXCEEDED');
    return ['word/document.xml', '[Content_Types].xml'].includes(entry.name);
  }});
  if (!files['word/document.xml'] || !files['[Content_Types].xml']) throw new Error('DOCUMENT_PARSE_FAILED');
  const xml = strFromU8(files['word/document.xml']);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('DOCUMENT_PARSE_FAILED');
  const decode = value => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    if (entity[0] === '#') return String.fromCodePoint(entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2),16) : Number(entity.slice(1)));
    return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[entity];
  });
  const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<\/w:p>/g)].map(match => match[1] === undefined ? '\n' : decode(match[1])).join('').trim();
  if (text.length > 100000) throw new Error('DOCUMENT_LIMIT_EXCEEDED');
  return text;
}
process.once('disconnect', () => process.exit(1));
process.once('message', async input => {
  let result;
  try { result = {text:await extract(input)}; }
  catch (error) { result = {code:['DOCUMENT_LIMIT_EXCEEDED','DOCUMENT_PARSE_FAILED'].includes(error.message) ? error.message : 'DOCUMENT_PARSE_FAILED'}; }
  // 원문 진단은 IPC/로그로 보내지 않고, 결과 전송 후 남은 네이티브 핸들도 종료한다.
  process.send(result, error => process.exit(error ? 1 : 0));
});
