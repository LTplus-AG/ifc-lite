---
'@ifc-lite/ids': patch
---

IDS numeric comparison no longer takes seconds per entity on a crafted property
value.

`packages/ids/src/constraints/comparators.ts` decided "is this a strict numeric
literal?" with `/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/`. On a string that
**fails** the match, `\d+\.?\d*` retries at every split of the digit run before
the engine gives up, so the cost is quadratic in the length. Measured here on
`'-' + '9'.repeat(n) + 'X'`: 26 ms at n=5,000, 413 ms at n=20,000, 3,701 ms at
n=60,000 — 4x the input for 16x the time.

That input is reachable. `compareNumeric` runs the check on the model side, and
`matchSimpleValue` / `matchEnumeration` call it once per entity, so an IFC
property whose value is a long digit run followed by any non-numeric character
costs that much per entity for the whole model. A validation run against an
uploaded file could be stalled by the file. Note that a long digit run *without*
the trailing character matches immediately, which is why this never showed up in
ordinary use.

Both call sites now use `isWhollyNumeric` from `@ifc-lite/encoding` — the
hand-written linear scan that already decides this exact language for the CSV
formula guard. Same three inputs: 0.008 ms, 0.031 ms, 0.090 ms. The scan is also
cheaper on ordinary values, which matters because this is a per-entity path
(1e6 calls on `'2022-01-01'`: 42 ms with the regex, 13 ms with the scan), and it
allocates nothing.

The accepted language is unchanged. `.5`, `5.`, `+.5`, `-5.`, `5.e3` and `1e+5`
are still numeric literals; `1e`, a lone `+`/`-`/`.`, the empty string,
whitespace-padded digits, `Infinity`, `NaN`, `0x10`, `1_000` and `2022-01-01`
are still not. That is pinned by running the removed regex as the oracle over
every string up to four characters from the alphabet the language is built from
(69,905 of them), not by a hand-written table. `@ifc-lite/encoding` is a new
dependency of `@ifc-lite/ids`; it has no dependencies of its own.

Two more copies of the same shape inside this package are bounded the same way,
on IDS-file literals rather than model values — lower reach, since they run once
per literal rather than once per entity, but the same cost curve on an uploaded
IDS file:

- `constraints/xsd-cast.ts` used a byte-identical regex for the `xs:double`
  strict cast; it now calls `isWhollyNumeric` too. 439 ms → under 1 ms at
  n=20,000.
- `audit/coherence`'s lexical-space table spelled the `xs:double` / `xs:float` /
  `xs:decimal` mantissa `[0-9]*\.?[0-9]*`, two adjacent digit runs with the same
  problem. It is now `[0-9]*(?:\.[0-9]*)?` — the same accepted language,
  including `NaN` / `+INF` / `-INF`, one parse per prefix. 415 ms → under 1 ms at
  the same length.

The IDS numeric tolerance rules and every other comparator are untouched, and
the buildingSMART IDS corpus stays at 334/334 parity.
