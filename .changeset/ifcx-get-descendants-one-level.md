---
"@ifc-lite/ifcx": patch
---

Fix `getDescendants` returning only the direct children instead of the whole subtree.

`getDescendants` (published from the package index) marked each child visited in the loop *before* recursing into it, so the recursive `traverse` call tripped its own `if (visited.has(n.path)) return` entry guard and returned without walking anything. The function was a one-level walk: for `a -> b -> c -> d` it answered `[b]` rather than `[b, c, d]`, and for a diamond `root -> {l, r} -> shared` it answered `[l, r]`, dropping the shared grandchild entirely. The child is now marked by the recursive call that opens on it, which is where the existing cycle guard already expects the marking to happen.

Found while mutation-auditing the tests added in this PR: neither test over the function could observe the truncation. One asserted only that the result is duplicate-free, which a one-level result satisfies; the other's expectation for a two-node cycle — `['b']` — is what the truncated walk produces anyway. Both now assert the reached depth directly.

No in-repo caller was affected (the function has no consumer besides the export and its tests), so this only changes behaviour for external users of `@ifc-lite/ifcx`, for whom it was previously unusable for its documented purpose.
