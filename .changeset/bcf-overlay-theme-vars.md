---
"@ifc-lite/bcf": patch
---

`BCFOverlayRenderer` now takes its colours from the host page's CSS custom properties instead of a hard-coded dark palette, so the marker tooltip is legible on light pages as well as dark ones (#5491). The tooltip reads `--color-popover`, `--color-popover-foreground`, `--color-muted-foreground` and `--color-border`; pins read `--overlay-status-danger` / `-warn` / `-ok` (open / in progress / resolved), `--overlay-ink-muted` (closed), `--overlay-ink` (any other status) and `--overlay-halo` (outline and index); the active marker is ringed in `--overlay-accent`. Every property has a light fallback, so a page that defines none of them still gets a readable dark-on-white tooltip.
