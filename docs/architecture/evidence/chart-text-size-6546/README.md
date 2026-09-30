# Chart text sizing (#6546)

These artifacts come from the real viewer and its browser PDF export at commit
`3a4ee84765c8568b14c3ad70c3b27489eaade251`. The
input is the committed public `apps/viewer/public/samples/building-architecture.ifc`,
whose IFC header identifies SketchUp 2024 (24.0.594) and IFC-manager 5.3.3.
Its SHA-256 is `3ff9b10bd00c7b96dded51e7ca5a6b69efbea38b049adcdd05fcd247de7e70d5`.

## Reproduce

1. Build workspace dependencies, start the viewer, and select **Load demo project**.
   This uses the canonical IFC load path.
2. Open **Document** and import [document.ifclite-document.json](./document.ifclite-document.json).
   It contains two stacked charts over the same names and IFC classes: the first
   retains its default font; the second has text size 8. It also includes a
   compact pie and element count. All charts read the loaded model, with no
   saved aggregate or fabricated SVG/PDF supplied by the evidence file.
3. Set the second chart's text size to 12 or reset it, then enter 8 and press
   Enter. The real T3 browser run used this control, persisted the edit, and
   recorded [browser-metrics.json](./browser-metrics.json) from rendered SVG
   text bounds. Its legend changed from about 36 px to 9 px; long axis names
   such as `geo-reference` and `house - gross volume` became fully visible.
4. Select **Export PDF**. [document.pdf](./document.pdf) is the actual download
   blob produced by jsPDF and svg2pdf (66,237 bytes, one A4 page), observed
   without replacing the download or PDF renderer. SHA-256:
   `79b9291a598f3f271a735dbbfd0bece460251ad83b467abe9eea35089539bd01`.

[preview.png](./preview.png) is a T3 browser screenshot of the mounted editor.
[pdf-page-1.png](./pdf-page-1.png) is the downloaded PDF rendered by PyMuPDF at
1.5 times page size. Both were visually inspected. [pdf-text.json](./pdf-text.json)
contains PyMuPDF's extracted text sizes and bounds: the default stacked legend
is 12 pt, the compact stacked legend is 8 pt, the compact pie legend is about
6.667 pt, and the compact count is 24 pt, retaining the renderer's relative sizes.

The sample yields 14 chartable representation-bearing instances. The viewer's
mesh counter displays 12; the charts include the two representation-bearing
reference proxies as well. Both stacked charts retain the same 14 buckets and
14 elements while their typography changes.

## Validation scope

The charts tests exercise real ECharts SVG output for all seven supported chart
types, actual legend positions, measured axis truncation, finite-size fallback,
and enlarged typography in short charts. The mounted editor test parses an IFC
geometry fixture and checks the actual preview, persistence/import, reset, and
PDF composition's heading-space invariant. Happy DOM's XML parser rejects
ECharts' valid CDATA style section, so that test does not claim browser PDF
coverage; the real T3 browser export above supplies it. This evidence is scoped
to chart text sizing, not a claim that the full repository test suite passed.

An ignored-font mutation (`chartFontScale(undefined)` in the option builder)
made 11 of the initial 12 chart tests fail while the 54 pre-existing chart tests
remained green. The implementation was restored byte-for-byte afterward.

Review added one further rendered-SVG regression for a multiline IFC Name.
It parses a documented derived version of the same SketchUp sample: only
wall #262's Name changes to `Fire\nrating\r\napproved` through IFC string
escapes. The exporter did not originally emit that name. Before the fix, an
actual legend glyph extended to y=48 while the grid began at y=44 in a
220×120 chart at text size 24. Custom legend labels now display on one line,
matching their measured row height; the underlying name, element ids, and
default pie formatter remain intact. Replacing the formatter with its old
implementation makes this regression fail, with the other 66 tests passing.
