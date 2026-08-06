---
"@ifc-lite/cli": patch
---

Reject a non-numeric, negative, or fractional `--limit` on `ifc-lite export`, `query --where` and `eval` instead of silently returning zero results.

`--limit` was parsed with `parseInt(limit, 10)` and fed straight into `Array.prototype.slice(0, n)`. A garbage value (a typo, or one forwarded unchecked from a script) parses to `NaN`, and `slice(0, NaN)` silently returns an empty array — the command "succeeded" (exit 0) with a header-only payload or zero rows even though matching entities existed. All three slicing call sites now go through a shared `validateLimit()` check (in `output.ts`) that fails loudly on anything that isn't a non-negative integer; `--limit 0` is unaffected and still produces a deliberate empty result. The `--group-by` paths were already benign (their `NaN` is caught by a truthiness check, so a bad limit was ignored rather than emptying the result) but read the same validated value now.
