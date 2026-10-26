# R146: merged-main source composition (2026-10-25)

This source-only composition starts from fetched GitHub main
`8e2778ca041f027ab95d59532ce43d18bb42dab6`, the merged #8106 engine,
and preserves #8134/#8137 infrastructure. Host source is the reviewed
`6996c40486c509e3f127f2244bdd3524f8fbd3f6` preparation; its production
behavior is unchanged. Accepted-main structural signatures, share guards and
lineage regressions are retained in the public/native and independent TS
oracle paths appropriate to each arm. Reviewed retained-callback GC tests are
included as test source.

E is the Rust public-facade arm. F is reconstructed from the new pre-public
sparse ancestor and the original R13/R94 TS delivery. Both retain the same
measurement protocol, input setup, raw WASM tests, GC harness and explicit
federation height policy. The E/F consumer initialization differences follow
their respective public implementations.

Status: **HOLD / UNQUALIFIED**. Source integration is separate from runtime
approval. No build, test, typecheck, install, benchmark, package binding or
fleet/storage task ran for this composition. The parent owns fresh final
qualification. The historical preparation notes below retain their original
refs and chronology; their pending foundation statements describe that prior
preparation, not the merged foundation used here.

---

# #8042 host observations: current-main source preparation

This focused layer starts at engine
`3e24cbe5519bc1e522d217d002c6a0e21d5da91f`, based on accepted main
`97d8add207104d5801c0c8d62e40fa7066e848f8`. It replays only R124's
`02-host` commit `088bf173390ebf44e65f14a638507c5486476b91`, adapting
the two live operations identified in the R128 compatibility audit.
The original engine, R124 layers, final arms and receipts remain historical
references. Foundation landing and runtime qualification are pending the parent.

## Current-main compatibility

Sidecar creation uses host `JSON.stringify` on a structural tuple of
`[base, here]` or `[relation, base, head]` (#8130/#8088). Rust captures the
callee and receiver before reading tuple fields, then invokes that captured
callee through a caught generic primitive. Field/array boundaries, arbitrary
UTF-16, host `toJSON`, first duplicate provenance, sorting and validation are
preserved. Creation still projects only known fields.

Live largest-share migration follows the exact accepted TypeScript short
circuits (#8131/#8084): truthy shares, equal head length, nonempty shares, then
`shares.every(share => Number.isFinite(share) && share >= 0)` before ranking.
Repeated getters, sparse/inherited slots and custom methods remain observable.
The existing best/tie loop and the foundation's native guard are retained.

R135 corrects the R134 review findings: live share callbacks preserve the
original falsy `Number.isFinite` result, and lineage-sidecar validation observes
that current host method after its noncoercive number type check. Both paths
return a boolean only when evaluating `share >= 0`. The raw JSON-text creation
ABI still throws diagnostic strings; live creation throws `Error` objects.
The same live-validation correction preserves `Number.isNaN(Date.parse(value))`:
the NaN callee is looked up before parsing, its return is observed by truthiness,
and a custom parse result passes directly to it without numeric coercion.

Retained method callbacks belong to host GC; borrowed iterator callbacks stay
within the synchronous caught visit boundary. Getter, method, predicate,
comparison and JSON failures return through caught imports. The projection DTO
reader also catches array-proxy length/index reads and object enumeration;
its existing DTO traversal and nesting limit are unchanged. Normalization keeps
host recursion outside active Rust callback frames.

The tie-filter predicate retains only its numeric index in Rust. A generic
caught bridge keeps its entry context in a JS lexical closure, preserving
dynamic getters and retained callback calls while removing the Rust backroot
through `entry -> shares.saved`. Survival tests are prepared for return, throw,
GC and reentry; post-release closure/externref reclamation still needs parent
measurement with the existing decode-leak harness. No runtime leak is claimed
proven or measured by this source correction.

## Tests prepared for parent qualification

The raw WASM tests in `packages/wasm/test/diff-host-*.test.mjs` cover the accepted
eleven-case dedup corpus through text and live exports, lossless keys, share
validation, sparse/custom observations, iterator closing, retained callbacks,
reentry and recovery. They run through the existing root pnpm/turbo test graph.
Missing artifacts skip explicitly; a skip does not qualify this layer.

Observation tests use independently built current-main production TypeScript.
At this host-only stage the local public TS graph retains those algorithms.
Set `IFC_LITE_CURRENT_MAIN_DIFF_ORACLE` to an independently built exact-main
`packages/diff/dist/index.js` when qualifying or composing later layers. A public
WASM facade is rejected as the staging oracle. Record its commit and emitted
graph separately; no historical R124 oracle expectations are used here.
The root Turbo `test` task explicitly passes this variable through its strict
environment. Tests report the selected entry's resolved path and SHA-256;
the expected main commit is a separate label, not inferred from those bytes.

The parent must build fresh payloads, verify generated declarations, run the
root test/typecheck graph, native workspace tests and strict Clippy, and repeat
the retained-callback cases with exposed GC. Both Node 22 and 24 remain required
where applicable. No builds, tests, installations, fleet/storage operations,
performance measurements, package rebinding or final-pair construction were
performed in this preparation. Source and syntax review do not qualify runtime.

Later public/oracle layers need the three accepted-main TS statement changes,
the relocated accepted regressions and corrected separator-conflict assertions.
Their precise adaptation handoff is recorded separately in the R132 receipt;
those later layers are not constructed here.

## Layer 5: private runtime and facade adapters

`stack/8042-v3-runtime-adapters` depends on the host-observer layer.
Private fingerprint, provenance, sidecar, iterable comparison and result
restoration adapters match full66. The column scalar guard is removed only
after the lower engine supports lossless model strings. Public exports remain
on the TS implementation until layer 7.

The Node asset resolver, retry behavior and full66 synchronous-versus-pending
async initialization guard arrive with the independent `wasm-runtime.test.ts`.
The unchanged public-facade race test waits until layer 7, where its oracle and
public initializer exports exist. The lossless `wasm-columns.test.ts` update
arrives here together with the column scalar-guard removal. These tests have
NOT run; the latest runtime guard itself is retained unchanged.
Package Node type dependency, lockfile, tsconfig and clean-dist build script
match integration. Build cleanup prevents stale removed JS entering later
published artifacts; no cleanup/build script was executed during preparation.

Parent qualification: regenerate the observer declarations as required by
layer 4, then root pnpm/turbo build dependencies/typecheck/test and actual WASM
adapter/runtime tests on this exact layer. Never substitute package-local
checks that bypass dependency builds. Additional differential tests using the
private oracle arrive with the coherent public cutover in layer 7.

## Layer 6: sparse fingerprint collections

`stack/8042-v3-sparse-fingerprints` depends on runtime adapters. Preserve the
exact native sparse collection representation, raw decoder and JS input
projection. The real-WASM outer-hole regression uses the public TS oracle
before cutover, preserving host TypeError and reuse of the same instance.
The isolated helper and all 90 facade comparisons arrive with their private
oracle at layer 7. Their bytes are retained from the integrated prototype.
The public index and collab manifest/lock dependency remain unchanged here.
No sparse or deep regression has been executed in this preparation.

Holes are only constructed by the raw host decoder, which reads one `length`
then inspects each array index (HasProperty, then Get only if present). This
does not claim full `Array.map` observation parity: live `map` and `constructor`
lookups remain outside the raw decoder contract. A present `null`/`undefined`
element is never a hole: it throws the oracle's `TypeError` at all five
collections (#8114). Serialized forms (JSON, document DTOs) cannot express
holes, so the native decoder is dense and rejects `null` records.

The bounded #8114 correction carries caught host exceptions out of band with
their original identity; no error-message marker is interpreted. Decode mode
and error state are scoped across nested calls. Every typed field Get (and
the missing-field HasProperty after undefined) is caught at its individual
host import, before an exception could abandon an owning serde/Rust frame.
Component decoding finishes each
whole property/quantity-set projection, checks that collection's outer holes,
then observes the next collection. Thus a null in the same array wins over a
hole, while a component outer hole wins over a later collection's error.
Array slots grow incrementally instead of reserving the supplied length, so
an invalid first record of an enormous sparse array can reject immediately.
Nested record-name schema errors retain the original single `Error:` prefix.

New actual-WASM regressions cover exact Error/Symbol identity (including
element getters, HasProperty traps and record getters), cross-collection error
precedence and reads, one length read and HasProperty/Get ordering, huge-array
early rejection, caught length/Array.isArray failures, reentrant mode/error
restoration and same-instance recovery. These tests and the corrected Rust
have NOT been compiled or executed in this source-only preparation. Parent
qualification must rebuild the exact final diff payload and run the actual
WASM tests without skips, native tests, strict Clippy and root pnpm/Turbo gates.
The decoder is used by the facade and remains part of final performance
qualification. No pre-existing primitive type-assignment/iterable-facade
normalization behavior or #8088 collision handling is changed here.

### Getter ownership correction on d7 (#8042/#8114)

The callback-wide catch in `d7cde23b633c6121bb2743ddd8bc4686dd0c0884`
restored the outer DecodeScope but could not drop partially decoded Rust
allocations after serde's uncaught imports threw through them. It is removed.
The private fingerprint deserializer preserves the typed field declaration
order, missing/default distinction, and ignored-field projection. Its caught
imports also cover nested dynamic array length/index reads, Object.entries,
iterability checks, iterator creation/next/done/value and Map pair members.
Object.entries still observes one object's members before decoding their
values, preserving the previous observation order. Invalid-type diagnostic
observations are caught too. Native dense JSON decoding is untouched.
The adapter retains the pinned binding's non-throwing instanceof probes and
i32 bool-return coercion rather than changing iterable interpretation. These
were compared with the [0.2.126 import and diagnostic generator](https://github.com/wasm-bindgen/wasm-bindgen/blob/0.2.126/crates/cli-support/src/js/mod.rs)
and its [bool-return conversion](https://github.com/wasm-bindgen/wasm-bindgen/blob/0.2.126/crates/cli-support/src/js/binding.rs).

`decode-leak-test` is a disabled-by-default Cargo feature. It adds only
`diffTestExternrefLiveCount`, backed by
`wasm_bindgen::externref_heap_live_count()`, to a separate test bundle.
The harness warms caches, repeatedly rejects getters after records with
substantial strings have decoded, and checks the exact live-owned-handle
baseline after every rejection and valid same-module reuse. It covers typed
fields, nested members and iterator steps; Error/Symbol/number/marker/object
exception identity; and typed field read count/order with ignored fields.
This checks owned externref release, not every Rust allocator byte directly.

Run from the repository root, on the exact committed candidate, through the
parent's managed task (all commands share its storage task):

```sh
~/build-workers/ifc-fleet run --cwd /absolute/isolated/checkout --storage-task TASK -- pnpm test:diff-decode-leaks
```

The root command executes `bash scripts/test-diff-decode-leaks.sh`: pinned
nightly wasm-pack release build of `rust/diff-wasm` with
`CARGO_UNSTABLE_BUILD_STD=std,panic_abort`, `--features decode-leak-test`,
`--target web`, and output `packages/wasm/pkg-diff-decode-test`; then
`node --expose-gc --test rust/diff-wasm/tests/decode-leak.test.mjs`. Neither missing
runtime/probe nor build failure can skip coverage or fall back to another
bundle. CI's build job calls the same root command after production type-sync
verification. The package publish allowlist excludes the test bundle; default
production ABI and committed declarations are unchanged. No declarations were
hand-edited or generated during this preparation.

This correction is source-only preparation: no Rust compilation, real WASM
execution, native suite, Clippy, root pnpm/Turbo checks or performance run was
performed. Parent qualification must run the new harness, rebuild the default
payload via `CI=1 bash scripts/build-wasm.sh`, verify declaration sync, and run
existing sparse/null/precedence/reentrancy/differential tests plus required
native/root checks. The P1 leak and ABI compatibility remain unverified until
those commands actually execute. Future end-to-end performance qualification
is still required; no performance verdict is claimed here.

The bounded follow-up on `dfbffe9706dc642da321ef481da008acbed0e5c5`
restores js-sys 0.3.103's three typed-array length reads/u32 coercions, with
fresh-copy allocation between reads one and two. Second/third-read getter
and coercion exceptions join the repeated identity/handle/reuse matrix; a
stable getter pins all three observations. Inconsistent observed lengths
now reject explicitly with a TypeError: no parity is claimed for inputs
violating the original unsafe allocation/slice assumptions, including a
reported length inconsistent with the underlying typed-array storage.
Actual WASM qualification remains pending; Node-only execution of the inline
host helper does not establish Rust ownership cleanup or compiled parity.
## Layer 7: public facade, oracle relocation and consumer initialization

`stack/8042-v3-public-cutover` depends on Sparse fingerprints.
Public operations switch together to the integrated Rust facade, with async
initialization at every integrated CLI/MCP/viewer/registry boundary and real
runtime setup in direct consumer tests. The historical TS engine and its
existing tests move to `packages/diff/test/oracle`; public declaration files
remain in src. The oracle shares public types and is excluded from published
output. Differential observation, UTF-16 and artifact tests arrive here with
their required oracle imports. The unchanged `wasm-runtime-race.test.ts` is
introduced here with its private oracle and public initializer exports.
API snapshot, changesets and guides are copied
from integration, not regenerated during preparation.

Existing vector generators switch to the private oracle with the relocation.
The real-fixture harness receives a minimal interim oracle-loader/runtime-init
adaptation so it still compares independent engines at this boundary; the next
layer replaces the complete harness with the exact integrated geometry version.
No fixture vectors are regenerated or repinned.

Parent qualification: rebuilt siblings and actual independent WASM payload;
root pnpm/turbo typecheck/test, public API/docs/artifact checks, real model
oracle parity, built viewer browser asset initialization/retry and consumer
commands. Node runtime coverage does not qualify browser loading. This layer
has approximately 1,500 changed production/tool lines after Git rename
recognition; the larger total diff is predominantly relocated oracle/tests.

## Layer 8: real-model and packed-package acceptance harness

`stack/8042-v3-acceptance-harness` depends on the public cutover.
The exact integrated real-geometry parity harness, bounded derived-revision
claims, geometry extraction helpers and packed Node 22 acceptance runner arrive
with their documentation. The existing CI real-IFC parity step retains its
five-minute timeout. Historical real-geometry preparation evidence is copied
unchanged as source provenance, not a result for these layer commits.

These tools require prepared package dist plus fresh geometry AND independent
diff runtimes, real fixtures, and the documented Node/pnpm environment. They
were not executed. Derived revisions are explicit synthetic mutations of real
geometry and are not authored split/merge ground truth. Preserve zero-execution
incomplete status and never treat missing-fixture coverage as acceptance.
Run packed acceptance inside parent admission, retain original receipts and
publish compact evidence outside generated workspaces before releasing them.

## Layer 9: end-to-end and large-revision performance qualification tools

`stack/8042-v3-performance-harness` depends on acceptance harnesses.
Exact integrated end-to-end protocol, receipts, isolated samplers/resolution
proofs and large-revision preparation/child tools arrive with their tests and
protocol docs. No protocol is relaxed and no benchmark is run. These are
qualification tools, not measured performance evidence for #8042 or this stack.

The parent owns all fleet admission, exclusive idle-window checks, paired
base-versus-branch measurements, source/build/runtime receipts, fixture and
output-identity evidence, compact evidence publication and generated workspace
release. Recover unknown outcomes by the original receipt. Performance verdict
and lesson remain pending until actual end-to-end measurements exist; do not
record a fabricated win in the performance ledger.
