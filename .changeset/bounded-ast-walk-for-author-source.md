---
'@ifc-lite/extensions': patch
---

Bound the AST walks over extension-author source so a deeply nested script is
reported, not fatal.

`validateCode` and `inferCapabilities` both fed an AST parsed from
author-supplied source to `acorn-walk`'s `walk.simple`, which recurses once per
AST level. A script nested a few hundred levels deep threw
`RangeError: Maximum call stack size exceeded` out of the middle of both
functions, escaping the result shape each one is declared to return. Measured
here, an 800-level script overflowed and a 700-level one did not, and which of
the two overflowed moved with test ordering — the failure point tracked whatever
stack the caller happened to have left.

Both now traverse through a new internal `walkBounded`
(`src/ast/bounded-walk.ts`), which keeps its own stack on the heap and stops at
`MAX_AST_DEPTH = 1000` (~500 source levels of `if (1) { … }`, below acorn's own
parse floor of roughly 1200). It descends using `acorn-walk`'s `base` visitor
and reports nodes in `walk.simple`'s post-order, so which child positions count
as nodes — non-computed member properties and object keys stay unvisited — and
the order they arrive in are unchanged. Behaviour below the bound is identical.

Catching the `RangeError` would have been the smaller change and is the wrong
one: it makes the accept/reject boundary depend on the remaining call stack, so
the same script passes on one code path and fails on another. The bound is a
reported result instead.

What each site returns at the bound:

- **`validateCode`** adds an `invalid_value` error naming the limit and returns
  `ok: false`. A truncated walk has not proven the source clean; anything below
  the cut-off went uninspected, so reporting `ok` would be a pass on a partial
  inspection.
- **`inferCapabilities`** returns an empty capability set *and* a `parseErrors`
  entry naming the limit. The capabilities found before the walk stopped are a
  floor, not the answer. Returning them alone would fail open in both callers:
  `migrateSavedScripts` treats an empty set as "grant `model.read` and migrate
  anyway", and the promote dialog renders it as "no `bim.*` calls detected".
  `parseErrors` is the channel both already use to refuse a script — the
  migration now skips it and the dialog shows its warning.

No public API change; `walkBounded` is not exported from the package entry
point.
