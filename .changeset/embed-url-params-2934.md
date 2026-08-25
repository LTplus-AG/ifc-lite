---
"@ifc-lite/embed-protocol": patch
"@ifc-lite/embed-sdk": patch
---

Embed URL parameters: document which are applied and which are still inert.

`?select=`, `?isolate=`, `?hideTypes=` and `?camera=` are now applied by the
embed viewer (they were parsed and never read). `EmbedUrlParams` and the SDK's
`EmbedOptions` now say so per field, and mark `controls`, `hideAxis` and
`hideScale` as parsed-but-not-implemented instead of leaving them looking
wired. `hideTypes` matches IFC class names case-insensitively, so the
SCREAMING_CASE spelling the SDK documents by example resolves the same as
PascalCase.

`select` and `isolate` now ignore empty or non-positive id segments (e.g. a
bare `?isolate=,`) instead of treating them as express id `0`, which used to
isolate nothing and blank the whole model with no error.

`?camera=` now requires every segment to be finite: `Number('Infinity')` is not
`NaN`, so `?camera=Infinity,0` used to clear the numeric filter and steer the
view to a non-finite azimuth instead of falling back to home framing.

`EmbedOptions` now carries `select` and `isolate`, serialised as comma-separated
query parameters. Both were already in `EmbedUrlParams` and applied by the
viewer, so an initial selection was previously reachable only by hand-writing
the iframe URL.
