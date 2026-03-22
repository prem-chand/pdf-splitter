import type { PDFDocumentProxy } from 'pdfjs-dist';

export type OutlineNode = {
  title: string;
  dest: string | unknown[] | null;
  items?: OutlineNode[];
  /** Filled by resolveOutlineDestinations while the PDF document is open */
  resolvedPage?: number | null;
};

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

/** Walk the outline tree and set resolvedPage for each node (needs an open PDFDocumentProxy). */
export async function resolveOutlineDestinations(
  pdf: PDFDocumentProxy,
  items: OutlineNode[] | undefined,
  progress: { n: number } = { n: 0 },
): Promise<void> {
  if (!items?.length) return;
  for (const item of items) {
    item.resolvedPage = await destToPageIndex(pdf, item.dest);
    progress.n += 1;
    if (progress.n % 24 === 0) {
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    if (item.items?.length) {
      await resolveOutlineDestinations(pdf, item.items, progress);
    }
  }
}

export function maxBookmarkDepth(items: OutlineNode[] | undefined, depth = 1): number {
  if (!items?.length) return 0;
  let max = depth;
  for (const it of items) {
    max = Math.max(max, depth);
    if (it.items?.length) {
      max = Math.max(max, maxBookmarkDepth(it.items, depth + 1));
    }
  }
  return max;
}

/** Collect outline nodes in DFS order: include every node at depth 1..maxDepth. */
export function collectBookmarksUpToDepth(
  items: OutlineNode[] | undefined,
  depth: number,
  maxDepth: number,
  out: OutlineNode[],
): void {
  if (!items?.length) return;
  for (const item of items) {
    if (depth <= maxDepth) {
      out.push(item);
    }
    if (item.items?.length && depth < maxDepth) {
      collectBookmarksUpToDepth(item.items, depth + 1, maxDepth, out);
    }
  }
}

export async function destToPageIndex(
  pdf: PDFDocumentProxy,
  dest: string | unknown[] | null,
): Promise<number | null> {
  if (dest == null) return null;
  let explicit: unknown[] | null = Array.isArray(dest) ? (dest as unknown[]) : null;
  if (typeof dest === 'string') {
    explicit = await withTimeout(pdf.getDestination(dest), 5000, null);
  }
  if (!explicit?.length) return null;
  const first = explicit[0];
  if (first && typeof first === 'object' && 'num' in first) {
    return pdf.getPageIndex(first as { num: number; gen: number });
  }
  return null;
}
