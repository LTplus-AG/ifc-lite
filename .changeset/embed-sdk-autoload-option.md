---
'@ifc-lite/embed-sdk': patch
---

Expose `autoLoad` on `EmbedOptions`, so an SDK host can suppress the automatic model fetch.

The viewer has honoured `?autoLoad=false` since the auto-load effect gained its gate, but the SDK's typed options object never carried the field. A host building the iframe URL by hand could opt out; a host using the SDK could not express it at all — the option existed on one side of the same API and not the other.

`embedUrlSearchParams` now emits `autoLoad=false` when, and only when, the caller passes `false`. This is the opposite polarity to `hideAxis`/`hideScale`, which default off and are emitted when true: `autoLoad` defaults ON, so omission and `true` are the same answer and neither is serialised. The literal string matters — the viewer parses the parameter as `autoLoad !== 'false'`, so any other value (`0`, empty) reads back as true and would load the model the host asked us not to.

Not included: a round-trip test binding the serialiser to the parser. `@ifc-lite/embed-sdk` and `apps/viewer-embed` do not depend on each other, so pinning the contract end to end would mean either a new dependency edge or a shared fixture in `@ifc-lite/embed-protocol` (the pattern used for the CSV and STEP escapers). Both halves are tested independently; the seam between them is not.
