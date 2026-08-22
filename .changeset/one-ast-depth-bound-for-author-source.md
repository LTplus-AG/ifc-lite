---
"@ifc-lite/extensions": patch
---

Give the package's author-source AST walks one depth bound instead of two copies of the same number.

`host/source-wrap.ts`'s `checkBannedConstructs` (#3025) and `ast/bounded-walk.ts` (#3027) landed the same day, each declaring its own private `MAX_AST_DEPTH = 1000`. Both bound traversals over extension-author-supplied source, and both refuse a script that exceeds the bound — so moving one alone would have opened a band where `wrapEntrySource` accepts a script that `validateCode` refuses, or the reverse, with nothing to catch it. `source-wrap.ts` now imports the constant from `ast/bounded-walk.ts`. No behaviour change: the value is the same 1000 it already was.

`bounded-walk.ts`'s module doc claimed to be "the single traversal used by every AST consumer here" and that callers "do not re-implement the traversal", which `checkBannedConstructs` had never been true of — it walks child properties generically, a superset of the positions `acorn-walk`'s `base` descends through. The doc now says which walks go through the module and which does not.
