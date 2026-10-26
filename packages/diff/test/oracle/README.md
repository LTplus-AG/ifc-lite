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
