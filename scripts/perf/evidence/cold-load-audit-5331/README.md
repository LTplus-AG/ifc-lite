# Cold-load avenues: current qualification record

Audit charter: [#5331](https://github.com/LTplus-AG/ifc-lite/issues/5331).
The project [ledger](../../README.md), its linked retained/rejected evidence,
current native and browser callers, and every entry in its dead-end and
mixed-status lever lists are the prior-art baseline. This is a ledger-led audit,
not a claim to have re-run every historical benchmark. Runtime source was read at
`52d30de0ae3fc8ef6322191bd1831483b93d485f`; the report includes the subsequently
merged spline result and links each independently scoped experiment. The five mechanisms below deliberately differ from the refuted levers.
A candidate is retained only after full-load evidence; implementing a prototype
is not a performance verdict.

| Avenue | New mechanism | Prior-art boundary | Current evidence / remaining gate |
| --- | --- | --- | --- |
| Surface spline samples | Reuse each axis sample and visit only nonzero coefficient pairs, preserving arithmetic order and product thresholds | Keeps #4901's degree/admission bounds and memoized recurrence; does not raise tessellation quality or budgets | [PR #5322](https://github.com/LTplus-AG/ifc-lite/pull/5322): qualified native win on the real spline fixture, exact producer output, browser compatibility without a demonstrated browser speedup; merged after all checks settled green and review feedback was resolved; the admin merge used the user’s conditional authorization after the normal queue remained blocked on an additional approval requirement |
| Direct attribute construction | Construct decoded values from the same canonical grammar without retaining an intermediate nested token tree | Different from retained lexical work and rejected extra decoder memos; transient string projection keeps its narrow parser path | [PR #5330](https://github.com/LTplus-AG/ifc-lite/pull/5330): implemented and rejected. Five native pairs on seven fixtures had exact output/diagnostic identity, mixed timing and no consistent memory win; no WASM qualification was pursued |
| Multipart mapped occurrences | Avoid per-occurrence mesh materialization for every eligible source part; retain full part identity through native consumer and WASM shard recovery | Extends #1623 single-solid don't-bake; does not turn content hashing back on or change the GPU repetition threshold | [PR #5335](https://github.com/LTplus-AG/ifc-lite/pull/5335): prototype implemented and parked. Fixture-backed workspace, real WASM and independent OpenUSD checks passed; no meaningful full-load benefit qualified. Timing contention and incomplete browser qualification remain explicit |
| Worker dependency packets | Replace each WASM worker's whole-file source copy with the exact source records needed by its assigned jobs | #1445 reduced indexes but increased build peaks; a packet needs bounded dependency discovery and source/index lifetime ownership, not another shared-index layout | Architecture candidate only. Native already borrows one source buffer, so this has no established native cold-load win. Packet construction and repeated dependency decoding must be counted in browser readiness. No shipping change justified yet |
| Broader analytic opening coverage | Handle proven overlapping cutter families without entering the exact 3D kernel | Different from parked world-frame void-cut dedup; never loosen the parallelism, closure, through-depth, or overlap correctness guards | Six-model diagnostic census shows most Holter openings already handled analytically; school/CSG residual opportunity concentrates in overlap vetoes. No safe generalization established; prototype would require an independent overlap oracle before timing |

## Prior-art decisions

More geometry workers, threaded WASM CSG, shared viewer indexes with transient
rebuilds, world-frame void-cut dedup, blanket content hashing, Manifold/BSP,
wasm-opt size-only tuning, and fixed-width bigint substitutions are recorded dead
ends or obsolete regimes. Their isolated wins do not establish current load wins.
The component-parity BVH, CDT vertex reuse, owned server batches, both server PGO
variants, and ordinal handoff also failed their end-to-end qualification. No
prototype here reuses their favorable subsets as evidence.

Retained work already removed unused parser WASM compilation, shared immutable
native indexing, compacted metadata/index handoff, bounded cache compression,
made drawing computation demand-driven, and reduced geometry bookkeeping/copies.
Those are current baseline behavior, not fresh opportunities. Brotli delivery and
unused exporter georeference extraction remain separate unqualified candidates;
neither is a demonstrated common native/browser load win.

## Qualification boundaries

Each retained mechanism needs its own source-matched base/candidate evidence,
five alternating fresh-process pairs, controls, complete output/diagnostic checks,
and memory/artifact provenance. A browser sample must complete actual worker-pool
loading and rendering; a native exporter win must not be presented as a default
server or flat-processing win. Tests running alongside a timing cohort invalidate
that cohort as controlled performance evidence. Warm OS caches, a shared host,
SwiftShader, and fixed post-readiness memory tails remain explicit limitations.

An unqualified experiment is preserved and parked; it is not merged merely to complete
a list of five. Correctness failures, missing fixtures, observer failures and
unmeasured endpoints remain visible in the record.

## Outcome boundary

One runtime optimization shipped. Two candidates were implemented and preserved
as unshipped experiments. Two architecture/algorithm candidates were parked
before implementation. This is not five shipped improvements or a proven
cross-target speedup. No candidate was retained merely to complete the list.
The linked PRs retain qualification limits, failures and reviewer responses.

## Dependency packet decision

Parked before implementation. Current `packages/geometry/src/geometry.worker.ts`
installs source bytes once into each worker API and reuses them through shard
scanning and meshing. A dependency packet would require a bounded transitive
closure over all geometry, placement, styling, units and recovery references,
plus coherent source offsets and content/quality invalidation. It must include
its discovery, packet construction, transfer and peak allocations in readiness.
That is a materially different design from the rejected shared-index layout,
but no measured full-load advantage has been established. Native
`rust/processing/src/processor/entity_index.rs::ProcessingIndex::decoder` already
borrows the shared content slice, so this mechanism does not remove equivalent
native source copies. It is not a qualified cross-target optimization.

## Analytic opening decision

Parked before changing geometry. The archived six-model diagnostic census was
run against the direct-attribute prototype with observability enabled, not a
pristine main build; source and artifact provenance are retained separately.
It is an opportunity screen, not a timing or correctness qualification.
`bool2d` counts hosts and footprints; `prism` counts hosts cut, analytically cut
openings and residual openings on those hosts. Defer counts are diagnostic events,
not unique openings; neither they nor CSG operation counts measure wall time.

The screen shows established analytic coverage on Holter, with remaining
opportunities on the school and CSG fixtures concentrated in overlap deferrals.
In `rust/geometry/src/router/voids/prism_cut.rs`, the overlap veto is decided for
all cutters before any cut. It prevents partially cutting a pair that the
analytic fusion cannot represent, then passing ambiguous coplanar boundaries
to the residual kernel. Removing that guard is not an optimization proposal.
A new union/classification algorithm needs independent overlap, depth, closure,
volume, winding and appearance oracles before end-to-end qualification. Earlier
#4610 mixed planar/residual and #3977 wall-local depth work constrain it. No
safe extension or browser/native speedup is claimed by this audit.

To reproduce the census, start at its recorded base, apply the archived
rejected-attribute patch, copy `opening_opportunity_census.rs` to
`rust/processing/examples/`, and build with:

```sh
cargo build --profile profiling -p ifc-lite-processing \
  --example opening_opportunity_census --features ifc-lite-geometry/observability
```

Run the resulting executable with the six fixture paths recorded in the JSONL.
Each completed model drains the process-global counters. This instrumentation
is an archived example, not a shipped profiling API or CI gate.
