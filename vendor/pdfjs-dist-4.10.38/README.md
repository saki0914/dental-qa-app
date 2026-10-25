# pdf.js 4.10.38 data files

- Version: pdfjs-dist 4.10.38 (the same version the app loads from cdnjs)
- Upstream: https://github.com/mozilla/pdf.js
- Source: the npm package `pdfjs-dist@4.10.38` (tarball SHA-1 `3ee698003790dc266cc8b55c0e662ccb9ae18f53`, as the npm registry lists it)
- `cmaps/`: all of the package's `cmaps/` (168 `.bcmap` files and their `LICENSE`, Adobe's BSD-style license)
- `standard_fonts/`: `FoxitSymbol.pfb`, `FoxitDingbats.pfb` and `LICENSE_FOXIT` from the package's `standard_fonts/`
- `LICENSE`: the pdf.js license (Apache License 2.0)

cdnjs serves only the builds of pdf.js (`pdf.min.mjs`, `pdf.worker.min.mjs`
and the viewer files), not these data files. pdf.js needs a CMap to read a
Japanese, Chinese or Korean font (for example `Adobe-Japan1-UCS2` for a CID
font without a ToUnicode map, as PDFs made on Apple devices embed Hiragino);
when it cannot fetch one, the whole font is left out and its text is not drawn.
The app therefore serves these files itself (`js/core/pdf-converter.js`).

The two standard fonts are the only ones pdf.js fetches while the app lets it
use the device's fonts (`useSystemFonts: true`): Symbol and ZapfDingbats when a
PDF uses them without embedding them.
