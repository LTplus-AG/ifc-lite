# Canonical paginated document preview — #6610, first slice

The Document panel now previews the same resolved blocks, measured glyphs and composed pages used by PDF export. Automatic overflow, page counters, table continuations and half-width blocks share the existing paginator. Continuations still select their authored block. Existing unresolved-binding cues, image replacement/error behavior, editing callbacks, localized labels and manual-report stamp visibility are retained.

This slice **Refs #6610**. Authored repeated header/footer bands with logo, date and text controls remain the next slice; this change does not complete the issue.

## Actual preview and downloaded PDFs

The native proof uses source `cd6785c3ea1f744ed98473615a6565b1f79d478e`, owned Linux Chrome 153 and the canonical file-input loader for the committed SketchUp 2024 sample `apps/viewer/public/samples/building-architecture.ifc` (SHA-256 `3ff9b10bd00c7b96dded51e7ca5a6b69efbea38b049adcdd05fcd247de7e70d5`, 444 parsed entities). The canonical document writer accepts explicitly authored demonstration documents; export uses the actual Document panel button and completed browser download, with the SVG/PDF exporter untouched.

- [Overflow PDF](overflow.pdf): two pages, 12,086 bytes, all 100 numbered lines; preview and independent PyMuPDF inspection both show two sheets and the correct counters.
- [All-kinds PDF](all-kinds.pdf): four pages, 25,523 bytes. Real model binding in Times-Bold 16 pt, a committed PNG image, actual ECharts SVG, a declared coordination topic, spacer, real wall Name table, explicit page break, actual IDS and information engine reports for four walls, declared manual pass/warning answers, and 80 continuing lines. Hidden manual stamp metadata is absent. Every PDF page counter agrees with its preview.
- `*-page-N.png` are unmodified native viewport screenshots. `*-pdf-page-N.png` are actual downloaded-PDF rasters, rendered with PyMuPDF at matrix `(1.5, 1.5)`. All six PDF pages and all six preview screenshots were visually inspected.
- `observations.json.gz`, `document.json.gz` and `physical-pdf-inspection.json.gz` retain the actual model/report summaries, persisted document round-trip and independent PDF text/font/image inspection. `native-proof.cjs.gz` is the exact successful browser recipe; decompress it, then run `node recipe.cjs OWN_WORKTREE NEW_OUTPUT_PREFIX OWN_PORT` against a normal root `pnpm dev` server.

The all-kinds screenshots were captured before the second export, so they retain the preceding two-page export toast. The actual final four-page export toast is recorded separately in the observations. Default preview and export clocks can differ by seconds; no timestamped byte-identity claim is made.

## Qualification and regression witnesses

Full consumer qualification source `2177bbf682b670ff72a761468ad88071bc14b722` integrates actual main `bd0d02782b92581ed8e007effc9d00e37a09476e`, including the canonical manual stamp and presentation-preserving snapshot helper. All 34 affected document test files pass 273 tests, with zero failures, skips or cancellations. Their actual root-Turbo logs and summaries are included.

Final source `cd6785c3ea1f744ed98473615a6565b1f79d478e` differs only by making the unused PreviewLayout interface private and correcting a label comment. On this exact source, plain root typecheck passes 109 tasks and checks all 3,248 test files; full root build passes 61 tasks; root lint passes over 8,143 files with zero errors and two untouched incoming example warnings. Final selected pagination/image/manual tests pass 22 cases. Official API update/check leaves the 51-package, 82-surface, 9,169-export snapshot unchanged. Docs samples (428 compiled samples), generated/readme, module-size, source-assertion, test-wiring and Changesets gates pass. The viewer MAJOR changeset was created by the actual Changesets CLI for the removed TablePreview export/module path.

The original mounted regression at `63325c571fbfaa390356917993f0c84858eab745` proves a real two-page jsPDF document was previewed as one page, and preview pages omitted counters. The exact final pagination oracle passes four controls, applies [the genuine three-path old-preview mutation](old-preview-runtime-mutation.patch.gz), then fails all four by assertion; restoration and a fresh root-Turbo four-case pass are verified. The oracle report incorrectly prints its broader 24-file classifier list; the applied patch contains only the three declared paths. An earlier path-filter attempt executed no assertions because the moved helper was omitted; its inconclusive log is retained.

A separate failed-topic-image oracle at `b389c90fc51b2ba120afe0a784951fa3f0944dc3` passes ten cases, then restoring the old square sizing fails the 4:3 fallback assertion (nine pass), and restoration passes ten. The 0.01 CSS-pixel frame tolerance accommodates serialization while distinguishing the old square frame. Ordinary failed images remain square; successful replacements use their measured aspect. The earlier overly strict precision failure is retained as a test failure, not a production mismatch.

## Limits and provenance

This is affected-document runtime coverage, not a full workspace runtime-suite claim. The whole-workspace knip removal scan remains non-green; its broad findings are retained and the newly introduced unused type export was removed. No baseline-wide clean claim is made.

The software WebGPU document/data route retains shader/device errors; it is not a 3D rendering or performance proof. Manual answers and the coordination topic are declared authored demonstrations, while IDS/information outputs come from the real engines. The first screenshot attempt failed on a stale element and is retained; the successful recipe waits for canonical load completion and takes fresh native page screenshots. A restoration helper invocation with the wrong relative path stopped before tests; the corrected root command passes.

[ARTIFACTS.md](ARTIFACTS.md) records hashes and sizes of the immutable packet. JSON, browser recipe and raw logs are gzip-compressed inert artifacts; `gzip -dc FILE.gz` reads them. The evidence-only publication commit does not alter the qualified source.
