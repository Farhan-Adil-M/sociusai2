/**
 * make-big-pdf.mjs — builds a genuinely valid, text-based multi-page PDF of
 * roughly `targetBytes` in memory. Used by the storage-upload e2e script to
 * exercise the >4 MB direct-to-Supabase-Storage upload path (and by the
 * storage probe for a tiny PDF). Every page carries real extractable text,
 * so pdf-parse can ingest it — padding is done with PDF comments inside the
 * content stream, which parsers ignore.
 *
 * Standalone:  node scripts/make-big-pdf.mjs [outPath] [targetMB]
 * Library:     import { buildBigPdf } from './make-big-pdf.mjs';
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function buildBigPdf({ targetBytes = 8 * 1024 * 1024, pages = 16 } = {}) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const parts = [];
  let size = 0;
  const add = (buf) => { parts.push(buf); size += buf.length; };
  // offsets[objectNumber] = byte offset of "N 0 obj" in the output
  const offsets = [];
  const addObj = (num, body) => {
    offsets[num] = size;
    add(Buffer.from(`${num} 0 obj\n${body}\nendobj\n`, 'latin1'));
  };

  add(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')); // binary marker comment

  const kidNums = [];
  for (let i = 0; i < pages; i += 1) kidNums.push(4 + i * 2);
  addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  addObj(2, `<< /Type /Pages /Kids [${kidNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages} >>`);
  addObj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const streamFor = (i, padLen) => {
    const text = esc(`Socius E2E storage check, page ${i + 1} of ${pages}: this big PDF travels through Supabase Storage instead of the serverless request body.`);
    return `BT /F1 12 Tf 60 760 Td (${text}) Tj ET\n%${' '.repeat(padLen)}\n`;
  };
  const baseLen = Buffer.byteLength(streamFor(0, 0), 'latin1');
  // Approximate everything that is not padding so the final file lands near
  // targetBytes (within a few KB is plenty for "~8 MB").
  const perPageFixed = 200 + baseLen;
  const tailEstimate = 20 * (4 + pages * 2) + 120;
  const padLen = Math.max(0, Math.floor((targetBytes - size - pages * perPageFixed - tailEstimate) / pages));

  for (let i = 0; i < pages; i += 1) {
    const pageNum = 4 + i * 2;
    const contNum = pageNum + 1;
    addObj(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contNum} 0 R >>`);
    const streamBuf = Buffer.from(streamFor(i, padLen), 'latin1');
    const head = Buffer.from(`${contNum} 0 obj\n<< /Length ${streamBuf.length} >>\nstream\n`, 'latin1');
    const tail = Buffer.from('endstream\nendobj\n', 'latin1');
    offsets[contNum] = size;
    add(head); add(streamBuf); add(tail);
  }

  const xrefOffset = size;
  const count = 4 + pages * 2; // object 0 (free) + objects 1..(3 + 2*pages)
  let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n += 1) {
    xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`; // exactly 20 bytes per entry
  }
  xref += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  add(Buffer.from(xref, 'latin1'));

  return Buffer.concat(parts);
}

async function main() {
  const out = path.resolve(process.argv[2] ?? '/tmp/opencode/big.pdf');
  const targetMb = Number(process.argv[3] ?? 8);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const pdf = buildBigPdf({ targetBytes: targetMb * 1024 * 1024 });
  fs.writeFileSync(out, pdf);
  console.log(`wrote ${out} (${(pdf.length / 1048576).toFixed(2)} MB, ${(pdf.length / 1024).toFixed(0)} KB)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
