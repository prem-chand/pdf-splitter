# PDF Splitter

A fast, privacy-first PDF splitting tool that runs entirely in your browser — your file never leaves your device.

[![Live Demo](https://img.shields.io/badge/demo-live-brightgreen)](https://prem-chand.github.io/pdf-splitter)

## Features

- **Split by chapters** — automatically detects the PDF's bookmark outline and creates one PDF per chapter (configurable depth)
- **Split by manual page ranges** — define any number of custom ranges with custom labels and filenames
- **Duplicate filename detection** — highlights conflicts before you export so you never get a broken ZIP
- **Invalid range warning** — flags rows where start page > end page with a visual indicator
- **Zero-server architecture** — all processing is done in-browser via [pdf-lib](https://pdf-lib.js.org/) and [PDF.js](https://mozilla.github.io/pdf.js/); nothing is uploaded anywhere
- **Cross-browser download** — uses the File System Access API where available, with a fallback `<a download>` link for Safari and Brave

## Usage

1. Click **Choose PDF** and select a PDF file
2. If the PDF has bookmarks, **By chapters** mode activates automatically — pick an outline depth in the dropdown
3. Switch to **Manual page ranges** to define custom splits instead
4. Edit any output filename to resolve duplicates (highlighted in orange)
5. Click **Create ZIP** to download all split PDFs in a single archive

## Development

**Prerequisites:** Node.js 18+

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Production build
npm run build

# Preview production build
npm run preview
```

The built output lands in `dist/`. It's a fully static site — serve it with any web server or host on GitHub Pages, Netlify, etc.

## Tech Stack

| Package | Purpose |
|---|---|
| [pdfjs-dist](https://www.npmjs.com/package/pdfjs-dist) | Parse PDF structure and resolve bookmark destinations |
| [pdf-lib](https://www.npmjs.com/package/pdf-lib) | Copy pages and write output PDFs |
| [jszip](https://www.npmjs.com/package/jszip) | Bundle split PDFs into a downloadable ZIP |
| [Vite](https://vitejs.dev) | Build tool and dev server |
| TypeScript | Type safety |

## Notes

- **pdfjs-dist 5.x transfers the source `ArrayBuffer` to its worker** via `postMessage`. The app passes a `.slice()` copy to each `getDocument()` call to keep the original bytes intact for `pdf-lib`.
- Large PDFs (100+ MB) are processed in-browser; memory usage scales with file size.
- Encrypted PDFs are opened with `ignoreEncryption: true` — output quality depends on the encryption level.

## License

[MIT](LICENSE)
