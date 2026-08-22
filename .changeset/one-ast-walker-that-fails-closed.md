---
'@ifc-lite/extensions': patch
---

Put the entry-script scan on the package's one AST walker, and fail closed on a
subtree the walker cannot descend.

Three follow-ups to the bounded-walk work, all latent rather than live — no
input reaching this package today takes any of the paths below.

**One walker, one bound.** `src/ast/bounded-walk.ts` opened with "this module is
the single traversal used by every AST consumer here… Callers vary the visitor;
they do not re-implement the traversal", while `host/source-wrap.ts` ran its own
hand-written traversal with its own private `MAX_AST_DEPTH = 1000` and its own
generic child enumeration. Two walkers and two constants with a comment telling
the next reader the second one did not exist. `checkBannedConstructs` now calls
`walkBounded`; the duplicate constant and the generic `childNodes` helper are
gone.

The migration narrows which child positions get *reported* — `acorn-walk`'s
`base` skips non-computed member properties, plain object keys, labels,
`ExportSpecifier`s and pattern `Property` wrappers, which the generic
property-crawl reported as nodes. It does not narrow what the scan *catches*: a
differential run over 59 sources placing each banned construct in an exotic
position found no banned node reached by the generic crawl and missed by
`base`, including the pattern-default case where the `Property` wrapper is
skipped but the `ImportExpression` under it is still visited via `ObjectPattern`.
The accept/reject depths are unchanged for both shapes measured (`if`-nesting
and arrow chains), and a test now pins `wrapEntrySource` and `validateCode`
against each other across the boundary so a future divergence fails.

**A missing `base` is now a failure, not a silent stop.** `walkBounded` reported
a node it had no `base` for and skipped its entire subtree. Every caller is a
scanner looking for things it must not find, so a skipped subtree was a scan
that failed open: `validateCode` returned `ok`, `inferCapabilities` published an
under-counted capability set, and `wrapEntrySource` wrapped the script — none of
them could tell "found nothing" from "never looked". `acorn-walk` throws on a
missing `base` for exactly this reason; we report instead of throwing because
these callers are declared to return a result. The result now carries
`unwalkableTypes`, and all three callers treat a non-empty list the way they
already treat `depthExceeded`. This becomes reachable the first time acorn is
upgraded ahead of `acorn-walk` — the skew that landed class static blocks,
import attributes and `await using`. Verified against acorn 8.18.0 /
acorn-walk 8.3.5: no node type acorn emits today is missing a base, and the
tests reproduce the skew by removing one `base` entry rather than waiting for an
upgrade.

**Two comments that named a number acorn does not have.** The walker's docstring
claimed acorn "gives up at roughly 1200 source levels" and `source-wrap.ts`
claimed "roughly twice this depth". Both understate — so they erred safe — but
as written they were the numbers a future reader would cite to justify raising
the bound. Measured on Node 22, the same script parses at 1100 source levels and
aborts the process at 1200 in a default-stack run (a fatal V8 abort, exit 134,
not a catchable error), is rejected at 1200 under this repo's vitest workers,
and parses at 4000 under `node --stack-size=4000`. The parser's give-up point is
a property of the host's remaining stack, not of acorn, and the docstring now
says so — which is the argument for a fixed heap-based bound, not against it.

`MAX_AST_DEPTH` is unchanged at 1000. No public API change; `walkBounded` is
still not exported from the package entry point.
