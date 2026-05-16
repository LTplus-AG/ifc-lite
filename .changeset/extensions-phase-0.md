---
"@ifc-lite/extensions": minor
"@ifc-lite/cli": minor
---

Introduce `@ifc-lite/extensions` package and the `ifc-lite ext` CLI
subcommand — the Phase 0 foundation of the user-customization /
AI-authored-extensions system designed in
`docs/architecture/ai-customization/`.

The package exposes:

- **Manifest validator** — hand-rolled, dependency-free; produces
  structured `{ path, code, hint }` errors for use by the future
  AI repair loop.
- **Capability grammar** — parser, matcher, OCAP catalogue, risk
  classifier, and set-diff for re-consent flows.
- **`when` clause language** — parser + evaluator for the slot
  visibility expressions used by host UI.
- **`SlotRegistry`** — in-memory pub/sub for contribution points;
  the substrate for Phase 1's host UI bindings.
- **Bundle loader and `.iflx` pack/unpack** — directory and gzipped
  JSON envelope variants, deterministic round-trip.

The CLI adds `ifc-lite ext validate <path>` (returns structured JSON
with `--json`) and `ifc-lite ext init <dir>` (scaffolds a minimal
valid bundle).

No host integration yet. UI loader, runtime activation, sandbox
wiring, audit log, AI authoring, flavors, and self-improvement loops
arrive in subsequent phases.
