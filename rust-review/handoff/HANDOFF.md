# Rust maintainability sweep: handoff (charter #7670)

Coordinator: b61983f5. Written 2026-10-17 at wrap-up. Repository: LTplus-AG/ifc-lite.

## 1. Ledger and decisions (622 findings)
- `ledger.csv` holds the canonical finding → WP map, one row per finding (622). It covers the disposition column, the issue column and re-maps.
- `ledger.md` holds decisions D1–D80, with D47 APPROVED by the maintainer, plus the full lane and merge log and the accepted debt.
- `PLAN.md` and `PLAN-REVIEW.md` are the plan, the wave order and the stop lines.
- `notes/{F2a,F3b,F3e,F4,C2,C4,C6,C9a}.md` are the design notes. Each lists its PRs, stop line and deferred work.
- `INDEX.md`, `REPORT.md` and `0x-*.md` are the original review reports, with the full text of every finding.
- `issues.tsv` maps each WP to its issue.
- Rules: `COORD-RULES.md`, `FIX-LANE.md`, `LANE-BRIEF.md`, `ADVERSARIAL-BRIEF.md`.
- Deferred work is listed on each open tracker issue and on each open PR as a "Sweep handoff" comment. See §5.

## 2. Worktree manifest
See `worktree-manifest.tsv` (path, branch, HEAD, origin head, unpushed commits, dirty files).

Pushed at wrap-up:
- `sweep/c2-5-voids-vocab` @ 87654c5ec1: local C2-5 work, 13 commits, no PR.
- `sweep/f3b-e1` @ 80eddff290: F3b E1 work, 7 commits, no PR.
- `sweep-archive/c4-5-scan-class-local` @ ffaf10c5d3: local leftover of C4-5, which is already merged as #7862.

Saved in `patches/`:
- **Uncommitted work:**
  - `c2-b-uncommitted.patch` + `c2-b-untracked.tgz`: in-progress C2-5 (opening_frame cluster core).
  - `c4-b-uncommitted.patch` + `c4-b-untracked.tgz`: in-progress C4-4b phases + new mod.rs.
- **Reviewer-local merge/verification commits** (never pushed, because main's history trips the attribution hook): `f4-merge.bundle`, `review-c2b.bundle`, `review-c6b.bundle`, `review-c6b-pr.bundle`. Restore with `git fetch <bundle> HEAD:refs/heads/restore/<name>`.
- `fix-unit-refused-ui` and `sweep-c6-c` local heads are pre-rebase leftovers of merged or rebased PRs. Nothing is lost there.

## 3. Ownership
- **Released to you:** all of F3b, C2 and C4, including every open PR and stopped lane.
- **Still active at handoff:**
  - the C6 reviewer: merging #7868, #7875, then #7895 (D47); this closes #7783;
  - the F4 reviewer: merging #7874 → #7876 → #7882 → #7888 → #7891; this closes #7778.
  If either has not finished, the PRs are approved-in-progress and can be merged with the same gate.
- No benchmark hold (`/home/louistrue/wt/.bench-hold` is absent). There is no ZBook lock or job of ours.

## 4. Validation evidence
Every merged PR below was merged only after a local full gate, on the exact merged tree or by the speed rule for disjoint main merges. The gate was clippy `-D warnings`, `cargo test --workspace`, parquet-bos, the CI-exact revert oracle (OBSERVED, or `revert-oracle-exempt` for pure refactors: #7807, #7833, #7855, #7856, #7884, #7885), the perf ratchet (no ceiling raised), node guards plus `.test.mjs`, and, where relevant, wasm-contract, pytest and corpus fingerprints.

Each PR's `## Adversarial review (coordinator b61983f5)` comment records:
- the exact commands;
- the fingerprint, oracle and perf numbers;
- any fixes the reviewer made.

Known main-red incidents were all fixed forward:
- #7814 (allowlist whitespace);
- #7817 (ALT pin) and #7826 (ALT census);
- #7824 (TS source-text guard);
- #7848 (machete + doc sample + python lock);
- #7872 (python issue_098 golden).

Merged during the sweep (number | merge sha | time | title):

| PR | sha | merged | title |
|---|---|---|---|
| #7702 | 890652f680 | 2026-10-15T17:16 | fix(landxml): resolve references in element text and keep the stream in sync (#7680) |
| #7705 | 925fab9f00 | 2026-10-15T20:24 | fix(processing): one large-stack rayon pool for native geometry, used by FFI, Python and s |
| #7703 | 45b52b1dd6 | 2026-10-15T21:28 | fix(server): walk material usages iteratively, scan server and export for unguarded walks  |
| #7706 | dbf11ee534 | 2026-10-15T21:33 | fix(rust): total-order float sort comparators and NaN admission for SpacePlate (#7674) |
| #7708 | 20c169a948 | 2026-10-15T21:55 | fix(server): upload admission and blocking work (#7676) |
| #7710 | 8bc11763c0 | 2026-10-15T22:05 | fix(export): frame STEP records through one trivia-tolerant reader (#7682) |
| #7701 | 470601e58b | 2026-10-15T22:11 | test(export): golden hash corpus for every export format (#7671) |
| #7700 | 7ffd346a25 | 2026-10-15T22:38 | refactor(rust): workspace dependency inheritance, drop unused deps, cargo machete gate (#7 |
| #7707 | 020faa8b95 | 2026-10-15T23:16 | test: golden hashes for server routes, LandXML parse JSON, symbolic data and the wheel JSO |
| #7704 | eace5dbfc6 | 2026-10-15T23:31 | fix(export): keep property sets linked through an IfcPropertySetDefinitionSet (#7681) |
| #7709 | 3a27672672 | 2026-10-16T05:58 | fix(server): cache-read admission and one cache-entry policy (#7676) |
| #7715 | 61d209288c | 2026-10-16T06:47 | fix(export): one emit path, one id allocator, one record index for the STEP writers (#7682 |
| #7733 | 0d9864c0c7 | 2026-10-16T08:33 | chore(rust): record semver break #11 (majorOffset 10→11) for the sweep campaign (#7670) |
| #7717 | 65379de4fb | 2026-10-16T09:08 | fix(rust): bound allocation and work sized by untrusted input (#7675) |
| #7726 | 34fd3ce5e6 | 2026-10-16T09:10 | fix(export): OBJ, USD and BOS restore the RTC/site frame in f64 through one home (#7684) |
| #7728 | 71320bf67e | 2026-10-16T09:45 | fix(processing): the symbolic overlay rebases georeferenced coordinates in f64 (#7684) |
| #7727 | 406957e683 | 2026-10-16T10:14 | fix(parity): one indexed-colour guard, one element fallback, one schema detector (#7691) |
| #7716 | b75ddf6c40 | 2026-10-16T10:32 | fix(geometry): one index rule for tessellated face sets, PnIndex on IfcTriangulatedFaceSet |
| #7725 | 2d5333ff92 | 2026-10-16T11:43 | fix(rust): typed refusals for panics reachable from file or caller input (#7677) |
| #7736 | 68619c1cd1 | 2026-10-16T12:37 | fix(export): schema conversion arity from core's registry; alignment proxies keep product  |
| #7743 | 540a1f1a1a | 2026-10-16T13:01 | ci(semver): reproducible baseline for yanked-dependency releases, zip 9 (#7737) |
| #7735 | 9d828796f2 | 2026-10-16T13:21 | fix(geometry): mapped-source walks through one per-item step; profile_extractor on the rou |
| #7738 | d8c110166a | 2026-10-16T14:02 | fix(export): energy exporters keep survey precision via an f64 profile transform (#7690) |
| #7718 | 932c7db80a | 2026-10-16T14:32 | fix(server,parser,export): budget material rows and complex-property output per model, gua |
| #7748 | 9c26c31341 | 2026-10-16T15:36 | fix(export): energy exporters: Ladybug identifiers, unique per-piece room ids, story order |
| #7746 | ccf60b6bc0 | 2026-10-16T15:53 | fix(landxml): one arc and length tolerance policy, assumed units in every family (#7693) |
| #7745 | ffb96cc393 | 2026-10-16T16:26 | fix(geometry): B-spline end parameter, conic frames, fail-closed curve and loop reads (#76 |
| #7763 | c44a0d7e67 | 2026-10-16T17:12 | fix(geometry): reset per-item refusal flags before each router item (#7687 follow-up) |
| #7760 | 83088e0260 | 2026-10-16T18:52 | fix(export): render-geometry exports fail closed on empty models (#7695) |
| #7764 | 74d097d01f | 2026-10-16T19:20 | test(processing): function-length ratchet, 150-line limit, 90-row seeded allowlist (#7697) |
| #7767 | 4f3197201f | 2026-10-16T19:48 | fix(export): one non-finite output policy for STEP, KMZ and the Python JSON surface (#7679 |
| #7768 | 0bfcd7f40b | 2026-10-16T20:19 | fix(ffi): accept non-UTF-8 STEP bytes in FFI and Python alignment_axes (#7694) |
| #7788 | 38577fa7f8 | 2026-10-16T20:37 | fix(python): name map keys in non-finite JSON refusals (#7679 follow-up) |
| #7747 | d895e14670 | 2026-10-16T21:07 | fix(geometry): keep profile holes and composite regions in swept solids (#7685) |
| #7762 | 126320e3e8 | 2026-10-16T21:41 | fix(geometry): boolean operand refusals, boxed and curve-bounded half-spaces, faceted brep |
| #7796 | 4728bb23c8 | 2026-10-16T21:57 | chore: remove committed Python bytecode caches and ignore them |
| #7789 | 4876448080 | 2026-10-16T22:24 | test(testkit): one fixture gate, STEP builder and mesh oracles for Rust tests (#7696) |
| #7798 | 0c721c3548 | 2026-10-16T22:38 | fix(ts-step): TS STEP readers match core grammar; guard PlacementRelTo cycle in lod0 (#778 |
| #7792 | 5e0766bd25 | 2026-10-16T23:55 | refactor(geometry): the cross-crate math home and its geometry leaf sites (#7772) |
| #7794 | 74def24d7e | 2026-10-17T00:37 | fix(geometry): planar face triangulation and winding, concave quads, held holes, SameSense |
| #7799 | d81654cc21 | 2026-10-17T01:17 | fix(geometry): *BrepWithVoids boolean cutters subtract their voids; cap bounded half-space |
| #7800 | f2d953a243 | 2026-10-17T01:42 | refactor(core): guid, hash, fmt_num micro-homes and byte-identical migrations (#7777) |
| #7803 | b59c05a0ad | 2026-10-17T02:14 | fix(curves): weighted rational B-spline curves, f32 admission for indexed polycurves, Firs |
| #7808 | f54be7d768 | 2026-10-17T02:20 | ci(semver): check the published git commit against the release tag; pin zip 9 understated- |
| #7805 | b2d6a29145 | 2026-10-17T02:50 | fix(landxml): defer stream header unit commit; one CircCurve length policy (#7753, #7754) |
| #7806 | ad3d150339 | 2026-10-17T03:08 | fix(export): drop non-numeric quantities, refuse non-finite geometry-data JSON, quiet NO_R |
| #7804 | c45ecbac3f | 2026-10-17T03:27 | fix(export): GLB-from-meshes, LOD1, Parquet and IFC5 restore the RTC/site frame; one inver |
| #7810 | eedb36a95e | 2026-10-17T04:11 | refactor(math): processing, wasm and server onto the shared math home (#7772) |
| #7809 | 88cd30ca8b | 2026-10-17T04:43 | fix(geometry): cap-hole hygiene, one planar-face home for polygonal faces, nested-shell or |
| #7812 | be93cb4269 | 2026-10-17T05:17 | perf(landxml): drop duplicate record deserializers from the wasm bundle (-54 KB brotli) |
| #7813 | d9cd4ce76e | 2026-10-17T05:22 | fix(clash): scale-free degenerate normals, certified depth for tiny members (F2a X5, #7772 |
| #7752 | bf1a4d2a14 | 2026-10-17T05:30 | fix(core): refuse non-finite STEP input at the decode boundary (#7678) |
| #7811 | ef274e89b3 | 2026-10-17T05:35 | refactor(geometry): mesh_check home and edge ledger (C2-1, F1a #7793) |
| #7815 | c9ec1a0886 | 2026-10-17T06:27 | feat(core): per-schema attribute slot lookup from the EXPRESS generator (F3e-0a, #7780) |
| #7769 | 810585d239 | 2026-10-17T08:02 | fix(geometry): register SurfaceOfLinearExtrusionProcessor with an f64 RTC hook, fail its c |
| #7820 | b174053bb4 | 2026-10-17T08:21 | fix(viewer,processing): surface refused length units instead of an empty model (#7678 foll |
| #7822 | 941ff6675c | 2026-10-17T08:45 | refactor(core): one numeric literal grammar and STEP binary literals (F4-1, #7778) |
| #7821 | c6d6eeeba6 | 2026-10-17T09:35 | refactor(core): one ProjectUnits, cached length scale, one IFCPROJECT locator (F3a, #7775) |
| #7829 | b9c87282c4 | 2026-10-17T09:37 | chore(core): F3a api-surface rows and break #11 account (#7775 follow-up) |
| #7827 | 53f067f0ff | 2026-10-17T09:40 | refactor(export): finish F2a (export onto geometry::math, wasm +0.0, largest-angle contact |
| #7831 | b95db45f7f | 2026-10-17T10:07 | refactor(landxml): pull-vs-stream differential oracle (C9a-0, 1/3) |
| #7832 | 2cded81961 | 2026-10-17T10:34 | refactor(landxml): reconcile the drift between the four front ends (C9a-1, 2/3) |
| #7833 | 85f8611de6 | 2026-10-17T10:53 | refactor(landxml): one xml::Budget for the limit counters (C9a-2, 3/3) |
| #7826 | e8ca66e037 | 2026-10-17T11:05 | fix(geometry): restore the ALT watertightness census after #7809 and #7762 |
| #7828 | 60b799d616 | 2026-10-17T11:41 | fix(core,testkit): finish F3d and F1b |
| #7834 | a2ea9cbc91 | 2026-10-17T11:48 | refactor(geometry): one 2D plane kit, math::v2 and math::geom2d (#7773) |
| #7835 | 54cda468af | 2026-10-17T12:24 | fix(geometry): exact self-intersection backstop for profile simplification (#7773) |
| #7836 | 62c6fd5de1 | 2026-10-17T13:16 | refactor(geometry): tolerance catalogue math::tol with documented units (#7774) |
| #7840 | bbb5694a74 | 2026-10-17T13:58 | refactor(core): one header keyword finder, one window, one literal decode (F4-2, #7778) |
| #7849 | be526bddcb | 2026-10-17T14:23 | refactor(core): StepRecord and the core fast readers on it (F4-3, #7778) |
| #7844 | 77f5d4b404 | 2026-10-17T14:34 | refactor(geometry): the placement module, chain walk moved out of the router (F3b R1) |
| #7839 | a279c2cfbb | 2026-10-17T14:50 | refactor(landxml): one xml::encoding::Decoder for pull and stream (C9a-3a) |
| #7841 | e59d683aac | 2026-10-17T15:05 | refactor(landxml): one xml::TokenScanner for pull preflight and stream framing (C9a-3b) |
| #7842 | 03ca170d21 | 2026-10-17T15:05 | fix(core): AttributeValue::Typed, as_logical and symmetric accessors (CORE-4, CORE-33, PRO |
| #7850 | fd505ec345 | 2026-10-17T15:06 | test(core): STEP grammar fuzz targets and a stable corpus-replay gate (G7, #7778) |
| #7843 | 2254f47451 | 2026-10-17T15:17 | refactor(landxml): one xml::refs decoder for text, attributes and GeneralRef (C9a-4) |
| #7846 | 5653c5459d | 2026-10-17T15:27 | refactor(landxml): xml::driver and the TIN FamilyHandler (C9a-5) |
| #7847 | a44024555f | 2026-10-17T15:35 | refactor(landxml): the plan family as a FamilyHandler on the driver (C9a-6) |
| #7851 | eb38e75482 | 2026-10-17T15:44 | refactor(landxml): the alignment family as a FamilyHandler on the driver (C9a-7) |
| #7845 | e0cc2e00d7 | 2026-10-17T15:49 | fix(geometry): one leaf rule on every placement reader (F3b X1) |
| #7853 | c8fe991375 | 2026-10-17T15:49 | test(processing): pin the entry points' output and event order (C4-0) |
| #7852 | 86cd4b944a | 2026-10-17T15:51 | refactor(landxml): the pipe family as a FamilyHandler; the stream owns one driver (C9a-8) |
| #7859 | 8e7a04c3e8 | 2026-10-17T15:58 | feat(core): generated typed attribute slots and typed accessors (F3e-0b, #7780) |
| #7858 | 8f4b790577 | 2026-10-17T16:09 | perf(landxml): one read of the bytes for every family; options endpoint returns pipe netwo |
| #7854 | d79c6f563f | 2026-10-17T16:31 | refactor(processing): one process() entry point with a request and a sink (C4-1) |
| #7860 | 65ce3b78d4 | 2026-10-17T16:43 | test(processing): positional-read ratchet for literal attribute indices (G-F3e, #7780) |
| #7855 | 272169ae31 | 2026-10-17T17:03 | refactor: production callers go through process() (C4-2) |
| #7856 | efef6edcd6 | 2026-10-17T17:28 | refactor(processing): tests and docs use process(); the ten delegates are deprecated (C4-3 |
| #7861 | 73d41608d4 | 2026-10-17T17:46 | fix(geometry,processing): IfcLinearPlacement and IfcAlignment.Axis at the declared schema' |
| #7863 | ac9970a8e2 | 2026-10-17T17:48 | refactor(processing,export): one budgeted property-set decoder for the server and the flat |
| #7857 | ed8260ad60 | 2026-10-17T17:59 | refactor(processing): the entity scan and the quick-metadata collector leave process() (C4 |
| #7862 | 592d84c970 | 2026-10-17T18:17 | refactor(processing): one keyword table for the scans, ScanClass (C4-5, processing half) |
| #7884 | b7507ec1c8 | 2026-10-17T19:59 | refactor(core): units, project_units and georef read through typed slots (F3e R-core, #778 |
| #7885 | a58f5263b3 | 2026-10-17T20:14 | refactor(export): the DecodedEntity readers go through typed slots (F3e R-export-a, EXPORT |
| #7866 | 9310a03923 | 2026-10-17T21:24 | refactor(processing,export): the export model moves into data_model::{rows,inherit,render: |

## 5. Next steps, merge order and stop conditions

### C6 (#7783), finishing
1. #7868 (C6-9) → #7875 (C6-10) → #7895 (D47 flat exports emit all property kinds).
2. Stop condition: all three are merged, and the route goldens are identical at RAYON 1 and 8 except the justified D47/IFCX re-pins. Then #7783 closes.

### F4 (#7778), finishing
1. #7874 M-proc → #7876 M-wasm → #7882 M-geom → #7888 M-export-a → #7891 M-export-b.
2. Retarget each PR to main as its predecessor merges.
3. Stop condition: #7891 is merged with export goldens, TS parity vectors and wasm-contract green. Then #7778 closes.
4. Not fixed, documented in the PRs: `mapOutsideStepStrings` stays comment-blind, and the `refilter::list_items` mirror remains.

### F3b (#7779), released
1. Re-run the full gate on #7896 (R2a); its oracle, perf and guards were interrupted.
2. One review of #7877 X2 → #7880 X3a → #7896 R2a, then merge in order.
3. Turn `sweep/f3b-e1` (E1, pushed) into a PR.
4. Implement P1 (symbolic cap per D27), P2 (symbolic chain), P4 (validators).
5. Two leftovers: the Rust chain cap vs TS, per D27; and `processors/tessellated/polygonal.rs:103` must refuse just the dangling face.
6. Stop line: C1, X1, X2, R1, X3a, R2a, P1, P2, P4, E1 (see notes/F3b.md).

### C2 (#7781), released
1. Fix the three node-guard failures on the stack first:
   - `check-float-sort-comparators` (`router/item.rs:22`);
   - `check-rust-api-surface` plus its manifest test (`RouterConfig`);
   - `generate-coverage-ledger --check`.
2. Review and merge #7867 → #7873 → #7881 → #7887. Each re-pins the `rust/geometry` digest, so rebase in order.
3. Continue C2-5 from `sweep/c2-5-voids-vocab` + `patches/c2-b-*`, then C2-6, C2-7 (delete `apply_void_context_inner`) and C2-8.
4. Fold in: the F2c ROUTER-47 voids tolerances; the #7799 `*BrepWithVoids` void handling, per D3.
5. Stop line: C2-1…C2-8 + X1.
6. Accepted census debt: rvt01 #26681 at 35 open edges; #26166 back to its main row; issue_472 area −0.024%.

### C4 (#7782), released
1. Continue from `patches/c4-b-*` (C4-4b phases), then 6a, 6b, 7a, 8a, 9, 10a, 10b, 11a, 11b (see notes/C4.md).
2. Pending maintainer decisions, with defaults applied: D66 (native layered-wall slicing: no); C4-8b (element colour change: deferred); FFI finishes (unchanged).

## 6. Support checkpoint
The "six findings in the support checkpoint" do not match any artifact in this ledger or the notes. Their disposition must come from the checkpoint's own source; this handoff does not claim them.
