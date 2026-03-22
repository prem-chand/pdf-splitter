import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';

export type SplitSegment = {
  startPage: number;
  endPage: number;
  filename: string;
};

export async function buildSplitZip(pdfBytes: Uint8Array, segments: SplitSegment[]): Promise<Blob> {
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const zip = new JSZip();

  for (const seg of segments) {
    const out = await PDFDocument.create();
    const indices: number[] = [];
    for (let p = seg.startPage; p <= seg.endPage; p++) indices.push(p);
    const copied = await out.copyPages(src, indices);
    copied.forEach((page) => out.addPage(page));
    const bytes = await out.save();
    zip.file(seg.filename, bytes);
  }

  return zip.generateAsync({ type: 'blob' });
}

/** Build a single-chapter PDF blob (no ZIP wrapper). */
export async function buildSinglePdf(
  pdfBytes: Uint8Array,
  startPage0: number,
  endPage0: number,
): Promise<Blob> {
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const indices: number[] = [];
  for (let p = startPage0; p <= endPage0; p++) indices.push(p);
  const copied = await out.copyPages(src, indices);
  copied.forEach((page) => out.addPage(page));
  const bytes = await out.save();
  // pdf-lib always uses a plain ArrayBuffer; cast so TS's Blob constructor accepts it.
  const buf = (bytes.buffer as ArrayBuffer).slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Blob([buf], { type: 'application/pdf' });
}
