# #6232 D5 design creation parity

This slice adds loaded-store SDK/MCP creation for curtain walls, grids and grid-bound columns through the existing Model workspace builders. It does not complete the 24-command charter.

Ground truth is the committed `apps/viewer/public/samples/hello-wall.ifc`, authored by Bonsai. SDK tests export and reparse the curtain aggregate and persisted grid-axis binding. MCP tests call the public JSON-RPC tools, prove compound Undo and foreign-model isolation, and reject invalid/stale parameters without changing records or allocating IDs. Viewer tests use freshly rebuilt real WASM and check complete member/panel/column bodies and graph/geometry Undo/Redo in one- and two-model cases.

Restored runs: `pnpm test --filter=@ifc-lite/sdk --filter=@ifc-lite/mcp -- store-design.test.ts design-place.test.ts` and `TEST_PATTERN='store-adapter-(design|stair-lifecycle)|useBimHost.stair-lifecycle' pnpm test --env-mode=loose --filter=@ifc-lite/viewer`. All 13 controls pass, no skips. Full SDK/MCP suites passed (311/546 tests, 6/5 optional fixture skips). Root typecheck, lint, documentation snippets/generated regions, module size, test wiring and source-text guards pass.

Inverse control removes only the three new producer handlers by restoring their parent-commit source; the new tests remain unchanged. Both SDK tests, four public MCP tests, and both design viewer tests fail on behavior assertions; read-only MCP and four existing stair/provider controls still pass. The three source files were restored byte-for-byte before the final green run. Raw filtered test output and source/artifact hashes are adjacent. The inverse viewer invocation overlapped the source revert, so it is failure evidence only, never a normal qualification run.

Browser screenshot qualification remains pending: the product-native T3 browser runs on a Mac and currently cannot reach this Windows/WSL host. These mounted real-WASM tests do not claim GPU/browser evidence. No Rust or geometry-kernel source is changed.
