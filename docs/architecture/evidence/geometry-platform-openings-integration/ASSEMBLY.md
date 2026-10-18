# Common opening program terminal port — round 2

Implemented and locally checkpointed, **UNQUALIFIED**. Final source is
`c9a75c988f8613fffabdd1f6efb8f7c6f837471c`, tree
`224e44c27e09231a9b1c468ba45ba8d83535e392`, on parent
`0c0e5734569b19f48eedc21703cdbf75d241a313` in app-created worktree
`/home/louistrue/.t3/worktrees/ifc-lite/t3-ff81c521`.
The worktree is clean. Nothing was pushed and no issue or PR was created.

Apply `incremental.patch` against that exact parent. It includes the verified
round-1 incremental delivery and the actual terminal/effect port, not inherited
child-base context. Do not wholesale cherry-pick the original child. Local
checkpoints are listed in `source-identity.json`; all 50 changed paths, base/final
Git blobs, SHA-256 hashes, lengths and deletion status are in `files.json`.
No file was deleted; superseded production bodies were removed in place.

The entire original receipt archive remains immutable at
`/tmp/ifclite-common-opening-program-round1`. Every entry in its SHA256SUMS was
verified, and all 27 delivered source hashes were checked against the original
child's Git objects. Its patch SHA-256 is
`7bbecf9eda12a2f519f220595c564bd69e16eac218a3184b466f8a3710c34e4b`.
The independent review was read in full and its supplied hashes were verified;
identities are recorded in `source-identity.json`. Its private-import and eager
OnceLock objections are implemented fixes, not waived objections.

## Consumed implementation and ownership

`build_void_context` drives `ProductProgram::host_openings -> HostOpenings::run`.
The common child owns ordered source classification and rectangle/profile
capture, then returns the single `ReadyVoidContext`. Whole representations,
placement, whole Items, selected raw-first meshes and direction-first nonraw
bounds retain their distinct ordering and ordinary source-fault recovery.
Occurrences are not memoized by ID. Quiet residual classification remains quiet.

`Execution` reuses the current parametric, planar, prism, origin-aware/local-frame,
batched, diagonal, nonrectangular and recovery algorithms. It contains quality,
lazy numerical gate function pointers and an owned effect buffer; it receives no
decoder/router/source callback. No analytic geometry was fabricated or substituted
for captured source geometry. The exact Rust kernel remains the only permanent
kernel; there is no alternate engine, loader, processor registry or production
fallback implementation.

`Configuration` construction initializes no gate. Reads occur at the original
reached routes. Mandatory correction short-circuits on empty cutters before
reading its gate, including after residual work. Actual custom callbacks can
therefore still mutate environment before an unreached OnceLock initializes.

`NumericalOutcome` carries `thread::Result<Result<Mesh>>`, owning its effects and
detached telemetry. Publishing consumes it. Typed terminal/final sticky stop is
checked before current-host effect/telemetry publication. Unwind publishes the
completed parent log and resumes the same panic payload. A staged child owns a
separate Execution and telemetry capture; refusal, terminal or unwind drops only
that child's unaccepted writes. Source effects and prior hosts remain outside
that domain; exact census/account/budget work is neither drained nor refunded.
The local-frame retry snapshot is owned request-local effect data, replacing an
inherited incompatible router snapshot call. It stores no borrowed guard.

Parent Boolean registrations, resource module, source/cache factories, late
presentation getters, ProductState terminal authority and checked CSG report
restoration remain the parent's implementations. This delivery does not define
an outer identity/lease/resumption protocol or claim a detached public scheduler.

## Terminal-port audit items 1–11

These are implemented source paths, not runtime qualification claims.

| Item | Applied seam |
| --- | --- |
| 1 | `program/openings/mod.rs`: fallible HostOpenings, checks at entry/phase boundaries and Ready; no stopped rectangle-to-planar or planar-to-exact continuation. |
| 2 | `openings/classify.rs`: fallible run/steps, observed body/bounds/repeated fallback-bounds/item meshes, decoder stop checks, checks before part/classification/host publication; earlier classification increments survive. |
| 3 | `openings/rectangular.rs`: `Result<Option<ParamRectCut>>`, checked host/opening probes and observed real mesh-volume reconciliation; ordinary None remains eligibility. |
| 4 | `openings/planar.rs`: fallible profile/solid capture, no residual ID or quiet classifier after stop; checked projection publication and final assembly. |
| 5 | `program/opening.rs`, `program/traversal.rs`, `voids/probe*.rs`: typed/sticky barriers before identity recovery, ordinary/raw fallback, more Items, direction-to-geometry, output and parser-walk continuation. Public rectangle Option adapters remain; canonical callers use checked `Result<Option<_>>` services. |
| 6 | `openings/execute.rs`: independently typed numerical result inside unwind transport; entry and publication barriers; same enclosing exact ElementState. |
| 7 | `voids/bool2d_path.rs`: `Result<Option<_>>`; explicit terminal errors retained before all extrusion/Boolean eligibility recovery, successful pure-2D path checked too. |
| 8 | `voids/staged.rs`: typed stop exits before residual/correction/topology acceptance, child append and detached telemetry commit; no full original-opening replay after stop. |
| 9 | `voids/mod.rs`, `prism_cut*`, `coaxial_union*`, `malformed_opening_repair.rs`: checked route candidates; checks after kernel group/sequential/union operations before recovery or consolidation, before more cutters, correction and success bookkeeping. Numerical Option candidates are interpreted only behind their fallible checked boundary. |
| 10 | `openings/effects.rs` and `execute.rs`: consuming effect assembly; final terminal prevents false current-host success, prior published hosts/source evidence untouched, unwind retains completed parent writes. |
| 11 | Parts/submesh void callers and `router/layers.rs`: fallible internal application and layer gateway; `?` precedes further cleanup/output/fallback. Layer source/drive checks precede skip diagnostics, host interpretation and final slice publication. Both real layered gateways consume the typed result. |

Probe source walks were split into `probe.rs`, `probe_rectangle.rs` and
`probe_solid.rs`, each below 400 lines. The 37 existing positional reads were
reallocated with no increase. The obsolete probe module allowance was removed
and its geometry digest updated. Numerical finalization was split into logical
helpers; function budgets were lowered/rekeyed, not raised. `opening_finish.rs`
is below 400 lines. No repository-wide formatting was run.

## Tests authored and routed through the actual code

All are **UNRUN**. Existing numerical tests use test-only adapters to the same
Execution algorithms, without an alternate production fallback.

- Actual selected custom callbacks stop on body, bounds and item-mesh calls with
  typed stop, sticky-stop plus real geometry, or sticky-stop plus ordinary error:
  exact reached callback count, no next opening/probe or false classification.
- Actual selected RTC callback returns typed stop, real rebased mesh plus sticky
  stop, or Option miss plus sticky stop: no ordinary callback or next item.
- Earlier completed containing host and occurrence survive a later stop:
  diagnostics, consumed marker, classification counts, exact cached mapped Arc
  identity and geometry retained; no retry and monotonic charged callback work.
- Earlier real profile decode/cache survives a stopped later checked probe with
  no later curve/point read; ordinary optional placement fault remains eligible.
- Real successful parametric cut never calls later gate functions; a fresh
  process performs earlier parametric success, then an actual selected callback
  mutates prism/union environment values before the still-lazy policy reads.
- Real execute then stop before publish rejects current-host consumed/cut effects.
- Actual staged planar success then stop at residual entry or after residual
  exact work before correction returns terminal without full replay/staged
  telemetry; prior host state and spent CSG census remain. Empty correction
  avoids an extra prism read.
- The original common processing fixture asserts disjoint/touching/overlapping
  geometry, both host leaves, volume/area/closure/provenance, rotated/mm/far-world
  frames and Reference-only behavior. Existing hole/local-origin/multiframe and
  other numeric suites remain required. No real exporter/model evidence is
  invented by these inline invariants.

## Narrow API for the consuming inner-program owner

No outer protocol was added. Reuse the actual internal seams:

- Source: `ProductProgram::host_openings(&DecodedEntity, &[u32]) -> HostOpenings`;
  `HostOpenings::run(self, &GeometryRouter, &mut EntityDecoder) -> Result<ReadyVoidContext>`.
- Ready payload: `router::voids::ReadyVoidContext` (alias `VoidContext`), containing
  owned classified/merged cutter geometry, reconciled rectangle data and full
  planar host profile/holes/f64 frame/depth/sense/residual context. It retains no
  decoder, selected processor, source callback or borrowed source state.
- Synchronous numerical seam: `ReadyOperation::new(mesh, &context, host_id,
  quality, configuration).execute() -> NumericalOutcome`;
  `NumericalOutcome::publish(self, &GeometryRouter) -> Result<Mesh>`.
- `numerical_configuration()` returns lazy pure gate policy, not eager values.
  `Execution` and its ordered effect log are internal numerical implementation.

ReadyOperation currently borrows the immutable ready context only for its
synchronous execution. **It is not a suspension payload.** The inner owner may
retain one `Arc<ReadyVoidContext>` with its owned continuation and create the
short-lived borrowed operation when synchronously executing each actual part;
this requires no deep context clone per part and no self-referential struct.
If it instead changes ReadyOperation to hold the Arc, preserve these checked
source/application/effect algorithms and public synchronous entry signatures.
No borrowed RefCell, telemetry transaction, TLS or ElementState guard should be
stored across suspension. Context ownership changes are left to that owner.

## Actual checks, refusals and remaining objections

`git diff --check parent..HEAD` passed. All 47 changed Rust files parsed with
pinned `rustfmt --emit stdout --config skip_children=true`, without writing source.
These are metadata checks only. They do not establish whole-crate type/privacy/
exhaustive-match correctness, executed regressions or behavior parity.

Fleet request `auto-0307e8163bcb475f93f4e5ae95a53644`, job
`4c6f9186-87d3-4c0b-a345-010baf665872`, pinned clean source `eb47838ce3`,
requested `cargo test --workspace --no-run`. It was refused before Cargo:
`Worker admission refused: disk 265.9 GiB free; require 266 GiB (reserve plus scratch; existing jobs continue)`.
Its receipt is copied verbatim as `receipt-compile-eb47838.json`.

The later clean-source `05390e81a6` combined workspace-tests/Clippy/canonical-WASM/
contracts request was classified host-bound by fleet and routed to local
admission. Job `b75a33a1-6ead-4508-8524-6613d8d11a55` was refused before the
command ran: `Worker admission refused: disk 265.9 GiB free; require 316 GiB (reserve plus scratch; existing jobs continue)`.
Its receipt is `receipt-checks-05390.json`. This is not a remote test run.

Final source `c9a75c988f` includes explicit planar terminal propagation after
those refused source checkpoints. **No earlier result is final-source runtime
qualification.** There is no admitted heavy result on final source. Pop's last
status has admission false/78; PC is reachable/configured, which is not admitted
capacity; Mac is disabled. No refused/unknown job was retried or bypassed.

Remaining objections are qualification: compile the whole workspace (including
all cfg(test) callers), run native workspace tests and Clippy, build canonical
WASM then execute real contracts rather than accepting their missing-runtime
skip, run available real-model/native/WASM comparisons and evaluate output pins.
Both standard external performance fixtures are absent here, so no real-model
comparison or paired worker-pool benchmark was performed. **Performance verdict:
UNQUALIFIED**, no speed, output-identity, full heap/RSS/process-bound or cutover
claim. Numerical/profile allocation coverage remains opaque; Strict continues
to refuse unsupported coverage and Compatibility adds no quotas.

The parent's original job `cd64c7d8-1708-42eb-9dc3-887359679a03`, request
`auto-0c630e8422f94ff7ba3ac4ea77fd711a`, its source checkout and session handle
were not touched, inspected, retried, cancelled or modified. No foreign jobs,
locks, credentials, worker source, or immutable evidence were changed or removed.
