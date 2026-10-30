# C4-11b structural layer (#7782)

C4-11a #8320 is merged on main at `7d391e2ad2`. This layer integrates that
main additively (original parent `6246d22dc4`, including #8317/#8318).
`ContentState` owns source bytes,
pending finalize finishes, derived slots and the existing ProductionModel.
Slot declarations generate the reset walk, including BRep signatures. The
one-lock `LazySlot::get_or_init` covers discovery and publication; explicit
installs retain poison recovery. Session settings and readable end-of-load
diagnostics remain on IfcAPI. `setSourceBytes` retains exactly C4-11a semantics.

PrepassMode couples sharded columns to external style ownership. Fingerprinting
is an independent PrepassOptions choice; all public positional signatures stay
unchanged. The second layer removes metadata snapshots and splits emission.

The concurrency witness uses the real type/mapped discovery on the in-tree IFC
fixture. Its reverse-applied mutation disables slot retention and must fail the
shared-plan ownership assertion. The C4-11a reset witnesses remain wired.
The selector is the first elif after acceptance-harness-8112; its extracted
shell passes `bash -n`. The patch passes `git apply --reverse --check`.

`api/mod.rs` shrinks from 949 to 378 lines. The 125-line `content_install.rs`
owns the public content-install/cleanup methods with unchanged bindings and docs;
the API module exception is deleted. This layer keeps the 501-line prepass
function budget until the completing split.
The C4-11a reset witnesses and concurrency witness passed in the completing
layer's pre-integration full workspace/clippy run at `3d5c31764b` on Pop
(`auto-9b0616c072274805b13a79b8547f58a6`); the reverse mutation was caught.
Post-integration results and exact fleet commands live in
`tests/evidence/c4-11b-prepass/README.md` on #8329. No timing speedup is claimed.

The initial slots task's field-owner compile error was fixed at `35eb14e3c7`.
Its evidence was published, the task closed, and its unused generated checkout
reclaimed through registered storage: 942,592,000 bytes. Shared caches and foreign
work were preserved.

## Round 1 review and size closure

`ContentSlots::clear` is module-private, so dereferencing `ContentState` cannot
bypass `production_model.invalidate_source()`. `LazySlot::get_or_init` documents
that its lock spans the builder, including same-slot serialization in a threaded
bundle. The completing layer documents its test-binary-wide global allocator and
thread-local counting gate. B-SIZE-01 is closed by the content-install extraction;
no public Rust/JS signature or committed declaration changes are intended.
The recomputed structural wasm module digest is `2729952386533288835`.

The owner accepted the independent review's repo-wide mobile-flake finding:
[run 40925029853](https://github.com/LTplus-AG/ifc-lite/actions/runs/40925029853)
on changeset-release/main `edfbe7ed7a` has the same expected-52/received-null
failure without this lane. `useTouchControls.ts:296-309` measures with `Date.now`
and rejects a tap lasting 300 ms or longer. Neither that behavior nor the E2E
spec is changed by this round; no Rust regression is asserted for the flake.

Before that review direction, Pop freshly built default WASM and the viewer at
`12fbb504618d`: the unchanged mobile spec passed all three tests (Chrome
156.0.8078.79, CI project/flags, only its executable path overridden because Pop
has no system Chrome). The original CI viewer artifact then passed all nine tests
across three repetitions. CI/fresh WASM deeply matched the authored model's
prepass and all 14 meshes, including finite slab 52 with 126 vertices/76 triangles;
the serialized result SHA256 is
`bcf3d830ca48cba5bcad73379bf2d909535953c964f4ef3773b71b6be4076b71`.
Requests: `auto-3ebd9e0c653347db84972cb8ae630090` and
`auto-50e87d072f0c4f31b07bf7481ca1539c` (both exit 0, source unchanged).

Earlier setup outcomes are preserved, not counted as test failures or passes:
`auto-5e8ed9c66a08465cb97931994d3484b6` built WASM then lacked installed pnpm
dependencies; `auto-edd9f47718864e5a9f653841eaf832d4` hit V8's ~2 GiB heap limit;
`auto-18132cead6744d2a8265f58375c68430` built the viewer with an explicit 8 GiB
heap inside a 20 GiB reservation, then could not launch absent system Chrome.
The following run extracted task-owned Chrome and removed it on exit.

At `b212a01977`, request `auto-1041a671b881469198dda575608b19fc` passed all
11 targeted C4-10a/C4-11 tests and 45 ratchet tests (two ignored reseed helpers),
then failed the structural mutation's old surrounding context after the new doc
line. The unchanged mutation was regenerated against the new comments.
At `ca4557b6ce`, static request `auto-5069183209c84b74974eb7bc87f9ea47` passed
module size, Rust API surface, AGENTS size, reverse-apply check and extracted
oracle `bash -n`. These precede B-SIZE-01; final extraction qualification follows.

Final structural code source `20a1316a1335dc700856f47d6b9a83035ef59e77`, Pop
request `auto-8422078e80354df6b91c0bcbd6ba6eda`, job
`41562f2d-0dc6-475b-950f-d8d642aacb24`: 11 targeted tests, 45 ratchet tests,
all three static guards, reverse-patch check and extracted oracle `bash -n`
pass. The two ignored tests are explicitly marked reseed helpers, not fixture
skips. Fresh default WASM plus diff bindings build successfully and exact-diff
against committed declarations; no drift. Project/fleet exit 0, source unchanged;
output SHA256 `fcf1cd7d64e6fd4d3be245fb7e5cc1ef5f43b4e03152859985cbeb97e1e8532c`.
Only evidence and patch context change after that source; the mutation itself
still replaces cached publication with `build()`. Its narrowed context keeps
comment edits from invalidating the control.

Exact final qualification command (both heads use the same recipe, sequentially):

```sh
~/build-workers/ifc-fleet run --host pop-os --storage-task c4-11b-fix-r1 \
  --cwd /home/louistrue/.t3/worktrees/ifc-lite/t3-26da8b18 -- bash -c \
  'set -euo pipefail; bash tests/evidence/c4-11b/validate-round1.sh; bash tests/evidence/c4-11b/validate-round1.sh wasm'
```

As directed after independent approval, broader new-head workspace/clippy,
TypeScript and real-WASM contract coverage is left to CI. Earlier full runs
retain their original source pins and are not relabeled as new-head results.

Round-1 storage task `c4-11b-fix-r1` is closed/released after verification of all
ten published job manifests, including known setup failures. Registered reclaim
stopped before removing worker workspaces with
`untracked/ignored file not promoted or catalogued: packages/wasm/pkg-diff/.gitignore`.
The six protected checkouts are the source pins `12fbb504618d`, `b212a01977`,
`ca4557b6ce`, `6401f12917`, `20a1316a13`, and `4d8cda58aa` under the Pop worker's
`worker-state/checkouts/`; their close inventory reports 7,407,050,752 allocated
bytes. No classifier, release metadata, source, fixture, shared cache or foreign
output was changed to bypass that guard. Local downloaded artifact copies
(243,289,411 logical bytes) were removed after retaining the small CI screenshot,
error context and hash/result summary in the thread's artifact directory.
