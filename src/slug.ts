export function titleToSlug(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}\s\-_.]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return s || 'untitled';
}

export function defaultChapterBasename(index1Based: number, total: number, title: string): string {
  const w = Math.max(2, String(total).length);
  const num = String(index1Based).padStart(w, '0');
  return `chapter-${num}-${titleToSlug(title)}`;
}

export function ensurePdfFilename(name: string): string {
  const t = name.trim().replace(/[/\\:*?"<>|]/g, '_').replace(/\0/g, '') || 'chapter.pdf';
  return t.toLowerCase().endsWith('.pdf') ? t : `${t}.pdf`;
}
