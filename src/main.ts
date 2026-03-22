import './pdf-setup.ts';
import './style.css';
import { getDocument } from 'pdfjs-dist';
import {
  collectBookmarksUpToDepth,
  maxBookmarkDepth,
  resolveOutlineDestinations,
  type OutlineNode,
} from './outline.ts';
import { defaultChapterBasename, ensurePdfFilename } from './slug.ts';
import { buildSplitZip, type SplitSegment } from './split-zip.ts';

type Mode = 'chapters' | 'manual';

type ChapterRow = {
  title: string;
  startPage0: number;
  endPage0: number;
  outputName: string;
};

type ManualRow = {
  startPage1: number;
  endPage1: number;
  title: string;
  outputName: string;
};

const state = {
  file: null as File | null,
  pdfBytes: null as Uint8Array | null,
  numPages: 0,
  outline: null as OutlineNode[] | null,
  outlineMaxDepth: 0,
  mode: 'chapters' as Mode,
  chapterDepth: 1,
  chapterRows: [] as ChapterRow[],
  manualRows: [] as ManualRow[],
  status: '' as string,
  busy: false,
  zipBuilding: false,
  /** When set, show a real &lt;a download&gt; (Safari / Brave–safe). */
  zipReady: null as null | { url: string; filename: string },
};

const app = document.querySelector<HTMLDivElement>('#app')!;

function eventToElement(e: MouseEvent): Element | null {
  const n = e.target;
  if (n instanceof Element) return n;
  if (n instanceof Text && n.parentElement) return n.parentElement;
  return null;
}

/** One listener survives every innerHTML refresh; capture phase avoids target quirks. */
app.addEventListener(
  'click',
  (e) => {
    const el = eventToElement(e);
    if (!el) return;
    if (el.closest('[data-action="export-zip"]')) {
      e.preventDefault();
      const btn = el.closest('[data-action="export-zip"]');
      if (btn instanceof HTMLButtonElement && btn.disabled) return;
      void doDownload();
      return;
    }
    if (el.closest('[data-action="dismiss-zip"]')) {
      e.preventDefault();
      clearZipReady();
      render();
    }
  },
  true,
);

function clearZipReady(): void {
  if (state.zipReady) {
    URL.revokeObjectURL(state.zipReady.url);
    state.zipReady = null;
  }
}

function stem(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function duplicateNameIndices(names: string[]): Set<number> {
  const count = new Map<string, number>();
  for (const n of names) {
    const k = n.toLowerCase();
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  const dups = new Set<number>();
  names.forEach((n, i) => {
    if ((count.get(n.toLowerCase()) ?? 0) > 1) dups.add(i);
  });
  return dups;
}

/** Bumped on each new file so in-flight bookmark work is ignored after a new load. */
let loadGeneration = 0;

async function resolveBookmarksInBackground(bytes: Uint8Array, outline: OutlineNode[], myGen: number): Promise<void> {
  const OUTLINE_TIMEOUT_MS = 120_000;
  try {
    await Promise.race([
      (async () => {
        // Slice so the transfer to the worker does NOT detach state.pdfBytes.
    const pdf = await getDocument({ data: bytes.slice() }).promise;
        try {
          await resolveOutlineDestinations(pdf, outline);
        } finally {
          void pdf.destroy().catch(() => {});
        }
      })(),
      new Promise<never>((_, rej) => {
        setTimeout(() => rej(new Error('Timed out resolving bookmarks')), OUTLINE_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    if (myGen !== loadGeneration) return;
    state.status = `Bookmarks unavailable (${err instanceof Error ? err.message : String(err)}). Use manual page ranges.`;
    state.outline = null;
    state.outlineMaxDepth = 0;
    state.chapterRows = [];
    state.mode = 'manual';
    render();
    return;
  }

  if (myGen !== loadGeneration) return;

  rebuildChapterRows();
  state.status = `Ready — ${state.numPages} pages, outline depth ${state.outlineMaxDepth}, ${state.chapterRows.length} chapter segments.`;
  render();
}

async function loadPdf(file: File): Promise<void> {
  loadGeneration += 1;
  const myGen = loadGeneration;
  state.busy = true;
  state.status = 'Loading PDF…';
  clearZipReady();
  render();
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    if (myGen !== loadGeneration) return;

    state.file = file;
    state.pdfBytes = buf;
    state.outline = null;
    state.outlineMaxDepth = 0;
    state.chapterRows = [];

    // pdfjs-dist 5.x transfers the underlying ArrayBuffer to the worker (see GetDocRequest
    // postMessage transfer list). Pass a slice so state.pdfBytes stays valid for pdf-lib.
    const pdf = await getDocument({ data: buf.slice() }).promise;
    if (myGen !== loadGeneration) {
      void pdf.destroy().catch(() => {});
      return;
    }

    state.numPages = pdf.numPages;
    state.manualRows = [
      { startPage1: 1, endPage1: pdf.numPages, title: 'part', outputName: '' },
    ];
    const raw = await pdf.getOutline();

    if (raw?.length) {
      state.outline = raw as OutlineNode[];
      state.outlineMaxDepth = maxBookmarkDepth(state.outline);
      state.chapterDepth = Math.min(state.chapterDepth, Math.max(1, state.outlineMaxDepth));
    } else {
      state.outline = null;
      state.outlineMaxDepth = 0;
      if (state.mode === 'chapters') {
        state.mode = 'manual';
        state.status = 'No bookmarks/outline in this PDF. Switched to manual page ranges.';
      } else {
        state.status = `Loaded (${state.numPages} pages). No outline — use manual ranges.`;
      }
    }

    void pdf.destroy().catch(() => {});

    if (state.outline?.length) {
      state.status = `Loaded (${state.numPages} pages). Resolving bookmarks (this can take a moment)…`;
    }
  } catch (err) {
    state.status = `Could not open PDF: ${err instanceof Error ? err.message : String(err)}`;
    state.pdfBytes = null;
    state.file = null;
    state.numPages = 0;
  } finally {
    state.busy = false;
    render();
  }

  if (myGen !== loadGeneration) return;
  if (state.outline?.length && state.pdfBytes) {
    const bytes = state.pdfBytes;
    const outline = state.outline;
    void resolveBookmarksInBackground(bytes, outline, myGen);
  }
}

function markersForDepth(maxDepth: number): { title: string; pageIndex: number }[] {
  const outline = state.outline;
  if (!outline?.length) return [];
  const collected: OutlineNode[] = [];
  collectBookmarksUpToDepth(outline, 1, maxDepth, collected);

  const resolved: { title: string; pageIndex: number }[] = [];
  for (const node of collected) {
    const pageIndex = node.resolvedPage;
    if (pageIndex == null) continue;
    if (pageIndex < 0 || pageIndex >= state.numPages) continue;
    resolved.push({ title: node.title || 'Untitled', pageIndex });
  }

  resolved.sort((a, b) => a.pageIndex - b.pageIndex);
  const deduped: typeof resolved = [];
  let last = -1;
  for (const r of resolved) {
    if (r.pageIndex === last) continue;
    last = r.pageIndex;
    deduped.push(r);
  }
  return deduped;
}

function rebuildChapterRows(): void {
  if (!state.pdfBytes || !state.outline?.length) {
    state.chapterRows = [];
    return;
  }
  const markers = markersForDepth(state.chapterDepth);
  const n = state.numPages;
  const rows: ChapterRow[] = [];
  const total = markers.length;
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].pageIndex;
    const end = i + 1 < markers.length ? markers[i + 1].pageIndex - 1 : n - 1;
    if (end < start) continue;
    const basename = defaultChapterBasename(i + 1, Math.max(total, 1), markers[i].title);
    rows.push({
      title: markers[i].title,
      startPage0: start,
      endPage0: end,
      outputName: `${basename}.pdf`,
    });
  }
  state.chapterRows = rows;
}

function applyDefaultManualNames(): void {
  const total = state.manualRows.length;
  state.manualRows.forEach((row, i) => {
    if (!row.outputName.trim()) {
      const basename = defaultChapterBasename(i + 1, Math.max(total, 1), row.title);
      row.outputName = `${basename}.pdf`;
    }
  });
}

function render(): void {
  const hasOutline = Boolean(state.outline?.length);
  const chapterNames = state.chapterRows.map((r) => ensurePdfFilename(r.outputName));
  const dupChapter =
    state.chapterRows.length > 0 ? duplicateNameIndices(chapterNames) : new Set<number>();
  const manualNames = state.manualRows.map((r, i) =>
    ensurePdfFilename(
      r.outputName.trim() ||
        `${defaultChapterBasename(i + 1, Math.max(state.manualRows.length, 1), r.title)}.pdf`,
    ),
  );
  const dupManual = duplicateNameIndices(manualNames);

  app.innerHTML = `
    <header class="header">
      <h1>PDF Splitter</h1>
      <p class="lede">Runs in your browser. Your file never leaves this device.</p>
    </header>

    <section class="panel">
      <label class="file-label">
        <span class="btn">Choose PDF</span>
        <input type="file" accept="application/pdf" id="file-input" hidden />
      </label>
      ${
        state.file
          ? `<p class="meta">${escapeHtml(state.file.name)} · ${state.numPages} pages</p>`
          : '<p class="meta muted">No file selected</p>'
      }
      <p class="status" id="status" role="status" aria-live="polite">${escapeHtml(state.status)}</p>
    </section>

    ${
      state.pdfBytes
        ? `
    <section class="panel">
      <h2>Split mode</h2>
      <div class="mode-row">
        <label><input type="radio" name="mode" value="chapters" ${state.mode === 'chapters' ? 'checked' : ''} ${!hasOutline ? 'disabled' : ''} /> By chapters (outline)</label>
        <label><input type="radio" name="mode" value="manual" ${state.mode === 'manual' ? 'checked' : ''} /> Manual page ranges</label>
      </div>
      ${
        !hasOutline
          ? '<p class="hint">This PDF has no outline. Use manual ranges and name each output file (fix duplicates before download).</p>'
          : ''
      }
    </section>

    ${
      state.mode === 'chapters' && hasOutline
        ? `
    <section class="panel">
      <h2>Outline depth</h2>
      <p class="hint">Include bookmarks from level 1 through this depth (depth 1 = top-level only).</p>
      <label class="depth-label">Max depth
        <select id="depth-select">
          ${Array.from({ length: state.outlineMaxDepth }, (_, i) => i + 1)
            .map(
              (d) =>
                `<option value="${d}" ${d === state.chapterDepth ? 'selected' : ''}>${d}</option>`,
            )
            .join('')}
        </select>
      </label>
    </section>

    <section class="panel">
      <h2>Chapters</h2>
      <p class="hint">Edit <strong>Output filename</strong> if two chapters collide. All names must be unique.</p>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>#</th><th>Title</th><th>Pages</th><th>Output filename</th></tr>
          </thead>
          <tbody>
            ${state.chapterRows
              .map((row, i) => {
                const dup = dupChapter.has(i);
                return `<tr data-chapter-idx="${i}" class="${dup ? 'row-dup' : ''}">
                  <td>${i + 1}</td>
                  <td>${escapeHtml(row.title)}</td>
                  <td>${row.startPage0 + 1}–${row.endPage0 + 1}</td>
                  <td><input type="text" class="filename-input" data-chapter-idx="${i}" value="${escapeHtml(row.outputName)}" /></td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
      ${state.chapterRows.length === 0 ? '<p class="hint">No chapters at this depth (missing destinations?). Try another depth.</p>' : ''}
    </section>
    `
        : ''
    }

    ${
      state.mode === 'manual'
        ? `
    <section class="panel">
      <h2>Page ranges</h2>
      <p class="hint">Pages are 1-based, inclusive. Set a short label for default filenames, then override filenames if they collide.</p>
      <div class="table-wrap">
        <table class="data">
          <thead>
            <tr><th>From</th><th>To</th><th>Label</th><th>Output filename</th><th></th></tr>
          </thead>
          <tbody>
            ${state.manualRows
              .map((row, i) => {
                const dup = dupManual.has(i);
                const invalidRange = row.startPage1 > row.endPage1;
                const rowClass = dup ? 'row-dup' : invalidRange ? 'row-invalid' : '';
                return `<tr class="${rowClass}">
                  <td><input type="number" min="1" max="${state.numPages}" class="num-input" data-manual="${i}" data-field="start" value="${row.startPage1}" /></td>
                  <td><input type="number" min="1" max="${state.numPages}" class="num-input" data-manual="${i}" data-field="end" value="${row.endPage1}" /></td>
                  <td><input type="text" class="text-input" data-manual="${i}" data-field="title" value="${escapeHtml(row.title)}" /></td>
                  <td><input type="text" class="filename-input" data-manual="${i}" data-field="output" value="${escapeHtml(row.outputName)}" placeholder="auto if empty" /></td>
                  <td>${invalidRange ? '<span class="range-warn" title="Start page is after end page — they will be swapped on export">⚠</span>' : ''}<button type="button" class="btn-small danger" data-remove-manual="${i}">Remove</button></td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
      <button type="button" class="btn secondary" id="add-range">Add range</button>
    </section>
    `
        : ''
    }

    <section class="panel actions">
      <h2 class="actions-title">Export</h2>
      ${
        state.zipReady
          ? `
      <p class="hint">Use this link to save the ZIP (required on Safari and many Brave settings).</p>
      <div class="action-row">
        <a class="btn primary" href="${state.zipReady.url}" download="${escapeAttr(state.zipReady.filename)}">${escapeHtml(state.zipReady.filename)}</a>
        <button type="button" class="btn secondary" data-action="dismiss-zip">Dismiss</button>
      </div>
      `
          : (() => {
              const hasDuplicates =
                state.mode === 'chapters' ? dupChapter.size > 0 : dupManual.size > 0;
              const isDisabled = state.zipBuilding || hasDuplicates;
              const label = state.zipBuilding
                ? 'Building ZIP…'
                : hasDuplicates
                  ? 'Fix duplicate filenames first'
                  : 'Create ZIP';
              return `
      <button type="button" class="btn primary" data-action="export-zip" ${isDisabled ? 'disabled' : ''}>
        ${label}
      </button>
      `;
            })()
      }
    </section>
    `
        : ''
    }
  `;

  document.getElementById('file-input')?.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    const f = input.files?.[0];
    if (f) {
      // Reset value so the same file can be selected again (change event wouldn't fire otherwise)
      input.value = '';
      void loadPdf(f);
    }
  });

  app.querySelectorAll('input[name="mode"]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const v = (e.target as HTMLInputElement).value as Mode;
      state.mode = v;
      if (v === 'chapters' && state.outline?.length) {
        rebuildChapterRows();
        state.status = `Ready (${state.chapterRows.length} segments).`;
      } else {
        applyDefaultManualNames();
        state.status = state.pdfBytes ? `Ready — manual mode (${state.numPages} pages).` : '';
      }
      render();
    });
  });

  const depthSelect = document.getElementById('depth-select') as HTMLSelectElement | null;
  depthSelect?.addEventListener('change', () => {
    state.chapterDepth = Number(depthSelect.value);
    rebuildChapterRows();
    state.status = `Ready (${state.chapterRows.length} segments).`;
    render();
  });

  app.querySelectorAll('.filename-input[data-chapter-idx]').forEach((el) => {
    const input = el as HTMLInputElement;
    input.addEventListener('input', () => {
      const idx = Number(input.dataset.chapterIdx);
      const row = state.chapterRows[idx];
      if (row) row.outputName = input.value;
    });
    // Use 'change' instead of 'blur': fires only when the value actually changes,
    // so Tab-key navigation doesn't destroy DOM focus by triggering an unnecessary render.
    input.addEventListener('change', () => render());
  });

  app.querySelectorAll('.num-input[data-manual]').forEach((el) => {
    el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      const idx = Number(t.dataset.manual);
      const field = t.dataset.field;
      const row = state.manualRows[idx];
      if (!row) return;
      const v = Math.max(1, Math.min(state.numPages, Number(t.value) || 1));
      if (field === 'start') row.startPage1 = v;
      if (field === 'end') row.endPage1 = v;
      render();
    });
  });

  app.querySelectorAll('.text-input[data-manual]').forEach((el) => {
    el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      const idx = Number(t.dataset.manual);
      const row = state.manualRows[idx];
      if (row) row.title = t.value;
    });
    // Re-render on change (blur with value changed) so the auto-generated filename
    // placeholder in the Output column updates as soon as the user leaves the Label field.
    el.addEventListener('change', () => render());
  });

  app.querySelectorAll('.filename-input[data-manual]').forEach((el) => {
    const input = el as HTMLInputElement;
    input.addEventListener('input', () => {
      const idx = Number(input.dataset.manual);
      const row = state.manualRows[idx];
      if (row) row.outputName = input.value;
    });
    // Use 'change' instead of 'blur' to preserve Tab-key focus in the table.
    input.addEventListener('change', () => render());
  });

  document.getElementById('add-range')?.addEventListener('click', () => {
    const last = state.manualRows[state.manualRows.length - 1];
    const start = last ? Math.min(last.endPage1 + 1, state.numPages) : 1;
    state.manualRows.push({
      startPage1: start,
      endPage1: state.numPages,
      title: 'part',
      outputName: '',
    });
    applyDefaultManualNames();
    render();
  });

  app.querySelectorAll('[data-remove-manual]').forEach((el) => {
    el.addEventListener('click', (e) => {
      const idx = Number((e.target as HTMLButtonElement).dataset.removeManual);
      state.manualRows.splice(idx, 1);
      if (state.manualRows.length === 0) {
        state.manualRows.push({ startPage1: 1, endPage1: state.numPages, title: 'part', outputName: '' });
      }
      applyDefaultManualNames();
      render();
    });
  });

}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

type SavePickerResult = 'saved' | 'aborted' | 'unavailable';

async function trySaveZipWithPicker(blob: Blob, suggestedName: string): Promise<SavePickerResult> {
  const win = window as Window & {
    showSaveFilePicker?: (options: {
      suggestedName?: string;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle>;
  };
  if (typeof win.showSaveFilePicker !== 'function') return 'unavailable';
  try {
    const handle = await win.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
    });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return 'saved';
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return 'aborted';
    return 'unavailable';
  }
}

function manualToSegments(): SplitSegment[] | null {
  applyDefaultManualNames();
  const segs: SplitSegment[] = [];
  const names: string[] = [];
  for (let i = 0; i < state.manualRows.length; i++) {
    const row = state.manualRows[i];
    let a = row.startPage1;
    let b = row.endPage1;
    if (a > b) [a, b] = [b, a];
    a = Math.max(1, Math.min(state.numPages, a));
    b = Math.max(1, Math.min(state.numPages, b));
    const fn =
      row.outputName.trim() ||
      `${defaultChapterBasename(i + 1, state.manualRows.length, row.title)}.pdf`;
    const filename = ensurePdfFilename(fn);
    names.push(filename);
    segs.push({ startPage: a - 1, endPage: b - 1, filename });
  }
  if (duplicateNameIndices(names).size > 0) {
    state.status = 'Duplicate output filenames — edit the filename column so every row is unique.';
    return null;
  }
  return segs;
}

function chapterToSegments(): SplitSegment[] | null {
  const names = state.chapterRows.map((r) => ensurePdfFilename(r.outputName));
  if (duplicateNameIndices(names).size > 0) {
    state.status = 'Duplicate output filenames — edit filenames so each chapter is unique.';
    return null;
  }
  return state.chapterRows.map((r) => ({
    startPage: r.startPage0,
    endPage: r.endPage0,
    filename: ensurePdfFilename(r.outputName),
  }));
}

/** Prefer chapter splits when that mode has rows; otherwise use manual ranges (same table as “Manual” mode). */
function segmentsForZip(): SplitSegment[] | null {
  if (state.mode === 'chapters' && state.outline?.length) {
    const ch = chapterToSegments();
    if (ch === null) return null;
    if (ch.length > 0) return ch;
    state.status =
      'No chapter bookmarks at this depth — using your manual page ranges below for this export.';
  }
  return manualToSegments();
}

async function doDownload(): Promise<void> {
  try {
    await runZipExport();
  } catch (err) {
    state.zipBuilding = false;
    state.status = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    render();
  }
}

async function runZipExport(): Promise<void> {
  if (state.zipBuilding) return;
  if (!state.pdfBytes) {
    state.status = 'No PDF loaded — choose a file first.';
    render();
    return;
  }

  const segments = segmentsForZip();
  if (segments === null) {
    render();
    return;
  }
  if (segments.length === 0) {
    if (!state.status.includes('Duplicate')) {
      state.status = 'Nothing to export — add at least one page range in Manual mode.';
    }
    render();
    return;
  }

  const zipName = `${stem(state.file?.name ?? 'document')}-split.zip`;

  clearZipReady();
  state.zipBuilding = true;
  state.status = 'Building ZIP…';
  render();
  try {
    const blob = await buildSplitZip(state.pdfBytes, segments);
    const picked = await trySaveZipWithPicker(blob, zipName);
    if (picked === 'saved') {
      state.status = `Saved ${zipName} (${segments.length} PDFs).`;
      render();
      return;
    }
    // 'aborted' = user closed the native save dialog; 'unavailable' = browser doesn't support it.
    // In both cases, fall back to showing a direct download link.
    const url = URL.createObjectURL(blob);
    state.zipReady = { url, filename: zipName };
    state.status =
      picked === 'aborted'
        ? `Save cancelled — click “${zipName}” below to download (${segments.length} PDFs).`
        : `ZIP ready — click “${zipName}” below to save (${segments.length} PDFs).`;
  } catch (err) {
    state.status = `Error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    state.zipBuilding = false;
    render();
  }
}

render();
