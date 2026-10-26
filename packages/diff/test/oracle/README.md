# Pre-cutover TypeScript oracle (#8042)

These algorithms preserve the TypeScript engine from before the public Rust
cutover. They exist only for independent differential expectations, Rust vector
generation, fixture authoring, and TypeScript performance baselines. Never use
them as a production fallback. Public declarations are imported from `src`, so
there is only one maintained type contract.

The colocated historical unit tests qualify this **oracle**, not Rust. Tests
named `src/wasm-*.test.ts` explicitly initialize the actual WASM engine and
compare its results against this oracle. Ordinary oracle tests never initialize
WASM globally; pre-initialization tests remain meaningful.

Run tests and typechecks through root `pnpm test` / `pnpm typecheck` (turbo).
The shared test program generator discovers tests outside `src` and uses the
repo root as its `rootDir`. The production tsconfig includes only `src`, with
`rootDir: src`; importing this oracle from production therefore fails emission.
The package build clears stale `dist` outputs, and the artifact inventory test
rejects published oracle/test/algorithm modules.

Node tools use `scripts/lib/diff-oracle.mjs`, whose explicit `tsx` loader works
on Node 22.13 without implicit TypeScript stripping. Vector generators always
use this oracle, never the public Rust facade. Existing pre-cutover benchmark
checkouts can continue to load their own built TypeScript engine.

Accepted-main corrections (#8130 / #8131)
----------------------------------------

The R133 source port deliberately changes three statements from the historical
R124 oracle: identity and lineage deduplication use structural JSON tuples
(#8088 / #8130), and largest-share migration requires nonempty, finite,
nonnegative evidence (#8084 / #8131). They are copied from accepted main
`97d8add207104d5801c0c8d62e40fa7066e848f8`, preserving private imports,
types and the independent TS algorithms. Original R13/R124 source and receipts
remain historical; the corrected oracle is not an exact historical snapshot.

Tests that accepted hidden separator conflicts or invalid-share successors
migrate to the accepted fixes, including their new getter traces. All supported
UTF-16, first-wins provenance, sparse-array, projection, iterator and exception
coverage remains. `src/sidecar-dedup.test.ts` retains the accepted corpus
assertions for this oracle and for the initialized public entry point; the
accepted 20-line lineage regression belongs in this directory's
`lineage.test.ts` after public implementation files become declarations.

These patches prepare future integration only. They do not qualify a new final
source, package, or A/B pair. Actual current WASM glue and binary must be built
with root `pnpm build:wasm`, then the parent must record non-skipped public, raw
and adapter results through root `pnpm test` / `pnpm typecheck`.
