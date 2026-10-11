# Passive symbolic parse completion observer (#6537)

Prototype on main `8570465acd2f68ef9b6f6e180d86af4636f52454`.
The current v3 token-based root Turbo selected suite passed all 52 cases (18 new lifecycle controls and
34 existing cache/dispatch controls), and plain root `pnpm typecheck` passed with
all 3365 test files covered by its audit. Scoped lint with denied warnings, module
size, test wiring, source-assert, license, syntax and diff gates passed.
The original source-only proposal and first dependency refusal remain retained.
The first actual suite had two test setup failures (callback URL depth and a
bucket fixture missing elevations); correcting those inputs retained all strict
assertions and changed no production source. Root Turbo's required viewer build
used fetched WASM; no Rust compilation, browser or model benchmark ran.
The finite false-success inverse changed only the null-dispatch outcome kind
while keeping the empty flat unchanged: seven real assertion failures among 18
controls, zero skips/load errors. Guaranteed byte-exact restoration passed the
same 18 controls. [Durable receipts](./evidence/symbolic-parse-outcomes-6537/README.md)
preserve the source hashes, full logs and historical failures.
This is observability prerequisite work, with no performance or complete IFC
text/appearance verdict.

`readSymbolicParseOutcomeCensus` is a standalone `page.evaluate` callback. It
reads the viewer-private `readSymbolicParseOutcomes` action. It never enables an
overlay, calls `ensureParseFor`, requests/renders a frame, intercepts uploads,
or changes the timed comparator or authored-text identity guard.

The canonical cache captures its already-computed key and binding when
`ensureParseFor` visits a usable source. A passive read compares current source,
room binding, spatial map references, mutation view/revision, and canonical
RTC/rebase scalar context. It does not compute source hashes or rebuild/digest
the spatial hierarchy. In-place spatial edits rely on the existing
`mutationVersion` publication contract; IFC source content identity retains the
existing immutable-content/cached-contentKey contract.

At real completion, weak metadata records success, skip (empty source or absent
owner types), or failure. Dispatch failures are observed before the existing
empty-flat projection; drawing callers retain their original never-reject,
empty-on-failure API. Logging, source handoff, worker timeout/disposal, cache
keys, notification order, failure memoization, and the existing result/flat LRUs
remain canonical. Raw exception objects/messages and authored IFC text are not
retained in the census. A successful worker reply does not establish authored
semantic completeness; it only establishes that this producer completed.

Metadata is keyed weakly by the real result/flat objects. The current v3 source
uses producer-assigned weak object identity tokens for its latest per-store
observation; it retains no old source, spatial map, mutation view, portable-room
source or room store object when a live store replaces that binding. Passive
identity reads are get-only and refuse unknown replacement references. There is
no parallel result cache or store list. The earlier v2 passes remain retained
with their earlier source; current validation runs the corrected v3 tokens with
the same unchanged lifecycle assertions. Completion epochs increase within the live session,
including through cache clears and eviction. Reads/cache hits do not increment
the epoch. An in-flight job remains in-flight through notification until actual
`finally` cleanup.

Result census counts annotation/grid lines, text entries, fills, and storey
buckets once at completion. It inspects array lengths, not text or primitive
contents. A result with more than 4096 buckets refuses census without truncating
production output. The current-model census is bounded to 128 models and
refuses unloaded, unobserved, pending-frame, in-flight, stale, evicted, untracked,
failed, or overbudget observations. No-model is also refusal. `complete` means
only that all current producer outcomes and this bounded census are available.

Controls use the real cache, dispatch handlers, bucketer, store action and
passive page callback with a held worker seam. They cover successful empty vs
worker-failed empty, crash/message failure/timeout/construction/post/source
handoff failures, unchanged drawing fallback, owner prefilter refresh, actual
notification/finally order, scalar RTC/rebase edits, spatial/mutation/source
rebinding, passive no-hash/no-walk/no-write reads, LRU/epoch, overbudget refusal,
room remapping/skip, and incomplete federation. They assert lifecycle invariants;
they do not run a real WASM parser, GPU, glyph atlas or model benchmark.
