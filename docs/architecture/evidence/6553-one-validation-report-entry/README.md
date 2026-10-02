# One Add block entry for validation reports

Captured from the real viewer (Vite dev server, Playwright's bundled Chromium) with one saved report of each
kind (IDS, information validation, manual), a current IDS run and a manual checklist present.
`browser-capture.cjs` reproduces it: `node browser-capture.cjs <worktree> <out> <port>`.

- `menu.png`: the Documentation Add block menu. The IDS, saved and manual report entries are one item, "Validation report".
- `block-editor.png`: the block that item added, with the "Saved report source" picker.
- `live-source.png`: the same block after choosing "Current IDS validation run (live)" in that picker: no saved
  report, and the Refresh button is back. The WebGPU notice is this headless browser having no GPU adapter; it
  is unrelated to the Documentation tab.
- `facts.json`: the menu items and picker options as text. The picker lists the three saved reports of three
  kinds, then the two live sources that exist (a live information validation run would read "Current information
  validation run (live)").
