## Latest integrated evidence

Prefer [parent-boundary-forward/README.md](./parent-boundary-forward/README.md): two fresh Physical runs use clean integrated source `983bf1665`, including the joined-Split parent-placement and Trim boundary fixes. Six retained Align, Placement and Room runs keep their original clean `acbc97c0b` source labels. The composed audit verifies all eight receipts,184 stages and436 native/displayed witnesses. Exact source/fixture/runtime identities and qualification scopes remain explicit; remaining main landings and current-head CI still gate readiness.

Earlier [772 Physical captures](./physical-repaired-forward/README.md) and the [complete acbc capture](./visible-integrated/README.md) remain available with their original identities.

# Integrated #6232 qualification

These are measured receipts, not a claim that the issue or stack is complete.
The Physical, Align and Placement captured source is clean commit
`bfc6d467c3e10387cf1e4dfe9da43066f139cb0e`: the complete modeling stack,
actual main through `43e9b79202e01c16ecb990f22496f33864260eb0`, the canonical
SpaceEnvelope body-item compatibility guard, and public MCP Flow creation
regressions. No production change occurred during these captures.

Headful `/usr/bin/google-chrome` on WSL loaded the committed Bonsai
`apps/viewer/public/samples/hello-wall.ifc` through the viewer's real file inputs.
The target was loaded first in fresh contexts with one and two models.
Fixture SHA-256 is
`0ab20f4ea355ea9aa4fade7264b97ee9f9929addfa3961b2437c4381bd674014`;
the freshly built and actually fetched WASM SHA-256 is
`7d63d9bc94333f10c4044eac3f70bd86bf361b98659ff5e6cb1161def46f597b`.
`manifest.json` and each compressed receipt record the source, Rust tree,
runtime, fixture, browser user agent, requests/replies and actual WASM responses.

| Suite | One model | Two models | Measured behavior |
|---|---:|---:|---|
| Physical | 21 stages passed | 21 stages passed | Paste, Duplicate, Array, Move, Rotate, dimensions, endpoints, Trim, Split and their Undo |
| Align | 17 stages passed | 17 stages passed | Six modes, two targets needing different translations, fixed orthogonal axes/reference, one Undo |
| Placement | 36 stages passed | 36 stages passed | Slab, beam, stair/flight, railing, curtain wall/members/plates, grid-bound column, opening, door, window, hosted slide and their Undo |
| Room | 18 stages passed | 18 stages passed | Query, Pick, cut, Cut Undo/Redo/Undo, Pick Undo and wall Undo; complete graph, typed quantities and geometry |

Receipts preserve the complete sorted exported EXPRESS graph, actual owning-model
mesh hashes including positions/indices/normals/color/origin, overlay records,
journal, allocator and history. Peer graph, geometry, journal, allocator and
history remain exactly unchanged. Fresh native geometry from the current export
must converge with the automatically updated displayed meshes. No producer
forces an extra remesh. Undo uses the real keyboard shortcut and checks the
prior whole graph, mesh state and history batch count. Mutation-row counts are
recorded separately: one atomic command can contain many mutations.

Physical and Align receipts were also audited after capture: every recorded
native/displayed triangle and vertex count matches. Placement additionally
checks those counts while waiting, which detects a stale host cut even when
its outer bounds are unchanged. The producer's worker instrumentation delegates
to the real client without changing arguments/results; displayed convergence,
not worker completion alone, is the completion oracle.

Screenshots are selected actual frames; full measured JSON is gzip-compressed
without dropping the source graphs. Reproduce using the committed producer
scripts, an independently qualified clean source checkout, a viewer on
`http://127.0.0.1:5189`, and these variables:

```bash
export IFC_SOURCE_ROOT=/absolute/path/to/qualified/worktree
export IFC_EXPECTED_HEAD=<exact-qualified-commit>
export IFC_FINAL_CAPTURE_TOKEN=FINAL_SOURCE_READY
export IFC_VIEWER_URL=http://127.0.0.1:5189
export IFC_EVIDENCE_DIR=/tmp/6232-final-evidence
node docs/architecture/evidence/6232-final-integrated/producers/physical.cjs
node docs/architecture/evidence/6232-final-integrated/producers/align.cjs
node docs/architecture/evidence/6232-final-integrated/producers/placement.cjs
node docs/architecture/evidence/6232-final-integrated/producers/room.cjs
```

Compressed root qualification logs belong to this captured source: typecheck
111 tasks/3,378 test files; whole MCP 615 passed plus five existing optional
skips; create split/size/overflow 23 passed and readers three passed; viewer
34 passed plus one initially absent AC20 fixture, followed by fetching that
manifest fixture and rerunning all 15 SpaceEnvelope controls with zero skips;
lint 8,464 files/no errors; docs 433; API 9,333; ambient BIM and module/source/
license gates passed. The WASM log records the actual fresh build. The final
public MCP Flow regression runs real native geometry for six ordinary kinds
in both model counts, uses the registered `run_flow` tool and nodes, and proves
one public `mutation_undo` restores IFC/native geometry and prior edits.

`producers/acceptance-matrix.md` preserves the original finite 24-command charter
and identifies the remaining native/MCP/registered-command scopes. Source
metamorphic millimetre/IFC4X3 controls are not independent vendor fixtures.
Later main SpaceEnvelope is preserved and separately tested, outside that
charter. These browser runs do not replace required current-head CI, current
review, resolution of every feedback thread, or final main integration.

The recorded Room failure is retained in `room-before-failed.json.gz` and its
original error log. `node producers/audit-room-before.cjs` (from this evidence
directory) proves that the narrowed export identity comparison still detects
all three actual class changes: GrossFloorArea and NetFloorArea become Count,
and GrossVolume becomes Count. It removes no quantity class, name, value or
unit from the oracle. `metadata-graph.cjs` normalizes only IDs/GUIDs of export
generated Pset/Qto scaffolding absent from both persistent source and overlay;
it rejects unexpected nonpersistent entity classes. Persistent product IDs and
GUIDs remain exact. This is necessary because export allocates scaffold IDs
above the monotonic allocator and creates fresh container GUIDs each time.
The Room producer retains both raw and canonical graphs; this adjustment
does not turn the failed Room run into a pass.

Run `node producers/audit-browser-receipts.cjs` from this evidence directory
to independently verify all eight archived receipts, each at its recorded source identity. The audit checks compressed receipt hashes, fetched runtime
bytes, complete peer state, finite native/displayed bounds and exact triangle/
vertex counts. It passed for these recorded receipts: 184 stages and 436 native witnesses.

Room was captured separately at clean `435e8842c07e757f08bf8607e0a52f7a429c9be3`,
after the canonical quantity-history repair. The fixture, Rust tree and fetched
WASM hashes remain identical. Both model counts pass actual keyboard Cut
Undo, Redo and a second Undo, including complete typed exported quantities,
canonical graph and actual native/displayed geometry. The original failing
receipt remains archived. The separate `quantity-types.log.gz` and
`quantity-viewer.log.gz` show root typecheck (111 tasks/3,381 test files) and
27 native/mounted viewer controls with zero skips for the repaired production
source. Earlier qualification logs retain their original source scope.

After the quantity repair and receipt archival, root Turbo reran the whole MCP
package with `--only --force` at clean `ba2dedc424cd7ce196dd4c3ef1892ed74e754d5c`: 615 tests
passed and five existing optional controls skipped across 68 files. No
dependency build/cache restoration ran; actual WASM hash was verified unchanged
before and after. `quantity-mcp.log.gz` preserves the run.

The later `physical-repaired-forward/` directory records two fresh Physical WSL Chrome captures at clean `77246bddd0f5e0b42b3440e9017fee3ab9aa9e92`, after the actual CI and StandardCase/shared-placement review fixes. Its composed eight-receipt audit retains the six Align/Placement/Room captures at their original `acbc97c0b` source identity and passes 184 stages/436 native/displayed witnesses. Its source-labelled qualification distinguishes current 111-task/3,389-file typecheck and 8,479-file lint from earlier union tests and bounded cleanup controls. Remaining main landings, current-head required CI and feedback still gate completion.


Current-main initialization composition is qualified separately in [`main-initialization-forward/`](./main-initialization-forward/README.md): fresh Physical one/two-model WSL Chrome receipts at clean `dc66bdb117009032892c0ef0b50038910f8d5802`, 111 root typecheck tasks/all 3,392 tests, 60 loader/bridge controls and 34 public native MCP controls. Six retained Align/Placement/Room receipts retain their original source identities. Earlier broader executions and captures above remain historical, not relabelled.


Latest current-main arithmetic/runtime qualification is recorded in [`current-arithmetic-forward/`](./current-arithmetic-forward/README.md): all eight browser receipts are fresh at clean `7f97b57aa98022ff478cdb302ab6b6ac0ee00452` with regenerated `de89ff1b` WASM, strict 184-stage/436-witness audit, Rust workspace and clippy, root typecheck, WASM contract and native command controls. The disk failure and exact successful execution scopes are retained. Earlier sections remain historical evidence with their original labels.
