---
"@ifc-lite/extensions": minor
---

Flavor `.iflv` packing + prompt overlay helpers + plan-stub generator.

Closes 4 more plan tasks on the library side. All host-agnostic, fully
tested headlessly.

- **`flavor/packer.ts`** (P3.T7, P3.T9) — `packFlavor(flavor, opts)`
  produces a gzipped JSON `.iflv` envelope embedding the flavor plus
  optionally each extension's `.iflx` bytes. `unpackFlavor(bytes)`
  validates the envelope, runs the flavor through `validateFlavor`,
  and surfaces decoded extension bundles. Same deterministic-output
  guarantee as `.iflx`. Strict base64 decode hardens against silently
  corrupted payloads.
- **`flavor/overlay.ts`** (P4.T11) — `clampOverlay(content)` trims +
  applies the 4000-token soft cap (configurable) before persisting the
  personal prompt overlay; `overlayParagraphDiff(prev, next)` lets the
  memory-extractor UI highlight added vs. removed paragraphs.
- **`miner/plan-stub.ts`** (P4.T7) — `planFromPattern(pattern)`
  translates a mined `MinedPattern` into an `AuthoringPlan` skeleton:
  one command + one toolbar contribution; capabilities unioned from a
  conservative per-intent map; one fixture-bound smoke test; notes
  field attributes the pattern occurrence count and last-seen time.

Side fix: `signing/base64.ts:fromBase64` is now strict (length % 4,
regex-validated alphabet). Was lenient before; corrupted payloads
would silently decode to garbage on Node. Matches the bundle/iflx
hardening from the PR-review pass.

Tests: 445 (+24 across 3 new test files). All source files under 400
lines.
