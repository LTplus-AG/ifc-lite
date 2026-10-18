Owned presentation assembly — round 1 implementation handoff

Baseline: e2e42bbfb8bd087a386450a0ab643bcb061c133c
Checkout: /home/louistrue/.t3/worktrees/ifc-lite/t3-0ea08063
Final local checkpoint: see checkpoint.txt (no publication)
Apply incremental.patch against the exact baseline. Verify changed-deleted-hash-manifest.json.

Production implementation
- presentation_source.rs is the only new late source-admission adapter. Validated
  ProductState acceptance drives it after actual geometry/custom callbacks.
- ReadyPresentation moves the runtime mesh/UV/texture payload, effective RGBA and
  material name, source/material discriminator, class, metadata identity, shared
  frame and palette handles, and hash policy into the numerical funnel.
- presentation.rs::assemble and assembly_{submeshes,fallback,types}.rs contain no
  decoder/router/source bytes/callback or hidden decoder-based assembly call.
- The submesh path repairs orientation/normals before style admission; then hashes,
  applies the historical texture UV guard, tries the indexed palette, else plain.
  Empty instanceable pieces use the SAME material cursor in collection order;
  other empty pieces do not resolve styles or advance that cursor.
- Fallback orientation/flipped-normal repair precedes the reached representation
  indexed-colour walk; accepted palette split hashes once; rejection repairs any
  missing normals, hashes and emits plain with no leaked palette source identity.
- Type-map ancestry resolves once before filtering/looping parts. The historical
  texture-presence UV policy and type hash exclusion remain distinct.
- Shared palettes retain the existing immutable model Arc plus its selected key,
  never a per-part copy. The selected map key and embedded geometry_id remain
  distinct for malformed-but-accepted inputs. Shared metadata is captured once
  per product, then Arc-cloned into parts. The direct borrowed assembly adapter
  keeps references and does not copy metadata or model maps.
- The existing outer ProductState protocol validates before any admission/hash/
  append. Ready packets are linear private values, without independent tickets.
  Native and browser callers still consume the same canonical Rust producer.
- Superseded decoder-reading emit_sub_meshes/emit_fallback_mesh/assemble_type_parts
  implementations are deleted, not retained as a fallback.

Narrow parent integration points / possible merge overlaps
- session.rs: optional presentation_context field and its default initializer only.
- owned_session.rs: bind clones the existing immutable context Arc into that field.
- session_state.rs: OwnedJob metadata is Option<Arc<ElementMeshMetadata>>; assembly()
  returns source-free shared identity, never the DecodedEntity.
- session_accept.rs: existing accepted-work branch delegates to presentation_source.
- element_color.rs: indexed-colour helper returns (selected key, map reference).
- element_mesh_build.rs: final funnel takes only site-local frame instead of context.
- accounted_session, session_canonical, session_owner and model_context untouched.
  No full resource-bound claim or resource accounting integration is made here.

Added behavioral tests (not executed; compile/type correctness unverified)
- direct authored style beats materials on real extrusion while buffers/hash/frame
  and metadata remain equal to plain geometry;
- actual template cache produces interleaved instance-only/materialized parts and
  proves one material-alternation cursor in both collection orders;
- actual custom extrusion callback redirects the late type-map ancestry lookup
  after producing geometry, preserving original geometry and changed effective color;
- real texture/type geometry preserves style, UV count, texture identity, metadata
  and type-map hash exclusion, with texture winning over a multicolour palette;
- invalid UV drops texture, reaches palette split; actual retopology rejects palette
  and does not leak palette geometry identity into fallback;
- fallback palette honors malformed embedded geometry_id vs selected map key and
  retains its exact shared context allocation after original owners drop;
- an owned ready packet assembles after actual decoder/router/source/job drop,
  comparing mesh buffers, normals, origin, bounds, transforms, appearance and metadata.
Existing owner/emitter/context/replay rejection tests remain on this actual path.

Validation and capacity limits
See validation-status.json and copied requests/receipts. NO Rust compile/test,
Clippy, actual WASM contract, Python, native scene or old/new baseline comparison
pass is claimed. Focused checks of earlier checkpoints were queued. Full workspace
and verbatim Clippy admissions were refused by Pop's disk guard. PC is 100% full;
its initial request failed while writing its empty claim before checkout/execution.
Original request/claim and receiver ordering were inspected; no uncertain job was
resubmitted. No foreign jobs, targets, source, locks or evidence were cleaned.

Lightweight checks passed: targeted rustfmt parsing of new/rewritten modules,
git diff --check, Rust source-text assertion guard, reference-walk guard. The
reference-walk guard printed 12 existing fan-out budget review notices.
Available prepared toolchain versions are recorded separately; availability is
NOT compiler/test execution evidence. Tests/fixtures were not reported as skipped
passes. There is no latency, allocation, memory-bound or performance claim.

Resume qualification when admission permits (root checkout commands):
/home/louistrue/build-workers/ifc-fleet run --cwd YOUR_CHECKOUT -- cargo test -p ifc-lite-processing --lib element::
/home/louistrue/build-workers/ifc-fleet run --cwd YOUR_CHECKOUT -- cargo test --workspace
/home/louistrue/build-workers/ifc-fleet run --cwd YOUR_CHECKOUT -- cargo clippy --workspace --all-targets -- -D warnings
Then build actual WASM before root pnpm test:wasm-contract; qualify Python's excluded
crate and the existing native-scene consumer against the exact parent baseline.
Use fleet admission and the prepared environment for all heavy commands. Keep
fixture skips and output-identity evidence separate from performance qualification.

Completion update: initial focused job e14ecaf6-2e8f-4b5f-b2bf-4f604ef95362
(source 9747de023a) exited 1 before compilation: Pop admission refused with
209.2 GiB free versus the required 316 GiB. Its final receipt is refreshed.

Completion update: second focused job 62c5c4ff-c020-4e67-b086-f5b573d5f2a2
(source 2db8855b54) also exited 1 before compilation at the same disk guard.
Both focused jobs are now terminal; neither remains queued. Final source remains
uncompiled and all runtime qualification remains pending.
