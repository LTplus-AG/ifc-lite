# C4-11b completing layer (#7782)

Stack: #8329 on structural #8328, on C4-11a #8320. The updated parent
`6246d22dc446705b7c5664e7b17972f1cc81235b` includes merged #8317/#8318 and is integrated in both heads.
The parent owns merges. Earlier qualification used C4-11a `06cf742446`.

`api/mod.rs`: 949 → 492 lines; prepass.rs: 583 → 92. The 501-line
pre_pass_streaming_impl exception and prepass module exception are removed.
The lowered wasm module digest is 9629139198197986638 (structural: 2062749831077530300).
Streaming scan/meta, event payloads, worker columns and post-scan emission have separate modules.
Existing sharded/postscan `with_arc_columnar_index` reuse is credited; only the serial copies are new removal.
JS signatures and declaration API tokens are unchanged; generated declaration changes are documentation only.
`batch_parity_expected.json` has no changes. The main WASM harness stays at 2,095 lines.

## Scoped allocation measurement

Native metadata handoff: allocation calls / requested bytes, exact prior populated-row copy vs shared lease:

| Fixture | Rows | Prior handoff | Shared handoff |
| --- | ---: | ---: | ---: |
| c4_bare_type_map_7782.ifc | 16 | 3 / 920 | 1 / 56 |
| c4_type_geometry_modes_7782.ifc | 33 | 3 / 1,720 | 1 / 56 |
| AC20-FZK-Haus.ifc | 44,249 | 3 / 1,638,520 | 1 / 56 |
| duplex.ifc | 38,898 | 3 / 1,638,520 | 1 / 56 |

Measured on Pop at `3d5c31764b`, repeated at `12c79d8adf`, with a thread-local counting allocator and real scanned indexes.
The prior copy is the exact operation in 6246d22dc4's prepass_memory.rs. This excludes initial
reservation/Arc allocation, scanning, metadata resolution/fallback, final columns and JS events.
No whole-prepass/worker-pool timing, speedup or browser peak-memory claim. The ledger records that limit.

## Qualification and negative controls

Pre-integration source `3d5c31764bfe5995b8fd128473fc39edb8f96917`, request
`auto-9b0616c072274805b13a79b8547f58a6`, Pop job `f25b4511-66b0-4db2-b1d7-b5441cbfcdf3`:
clippy -D warnings, full workspace tests (including C4-0 parity and all Rust ratchets),
all four allocation measurements and all three independent reverse mutations passed/caught.
The fresh WASM build succeeded; its strict declaration comparison stopped on a documentation-only diff,
so contracts did not run in that attempt. Generated documentation and API-token verification now cover it.

Post-integration source `12c79d8adf392306bbc3b85f8fe9bacfa97a571d`, request
`auto-e928ac1d3e754dc382d180d729726c46`, Pop job `5b0e78c9-00da-46c5-8a64-02084c35342c`:
clippy, full workspace/C4-0/ratchets, allocations and three controls passed; fresh WASM contracts: 258 passed, zero skips.
Project exit 0; fleet exit 1 because retained regeneration changed its tracked declaration documentation and .gitignore.
The exact generated declarations were committed; the generator now reproduces the tracked ignore rules.
Exact cohort command (ordinary admission, 4 CPU / 12 GiB, pinned repo toolchain):

```sh
~/build-workers/ifc-fleet run --route fleet --storage-task c4-11b-prepass-r1 \
  --cwd /home/louistrue/.t3/worktrees/ifc-lite/t3-0d2321cb -- bash -c \
  'cargo test -p ifc-lite-testkit --test fixture_reads_are_gated && cargo test -p ifc-lite-wasm --lib c4_11 -- --nocapture && bash tests/evidence/c4-11b-prepass/validate.sh native && bash tests/evidence/c4-11b-prepass/validate.sh wasm'
```

Clean confirmation at `60619604c7959039fc8f69b2434904d39eb06428`, request
`auto-0c4b789e7ba249abb3c7e4776c7e9ff4`, Pop job `8b45102f-25c6-49f2-b14d-8d6ea6db3768`:
fresh baseline/default/retained builds, strict generated-file drift check and 258 contracts passed, zero skips;
project/fleet exit 0, sourceUnchanged=true. Rust sources are identical to the full native qualification.

```sh
~/build-workers/ifc-fleet run --route fleet --storage-task c4-11b-prepass-r1 \
  --cwd /home/louistrue/.t3/worktrees/ifc-lite/t3-0d2321cb -- bash tests/evidence/c4-11b-prepass/validate.sh wasm
```

The recipe provisions all 182 cached fixtures with IFC_LITE_REQUIRE_FIXTURES=1; runs verbatim
workspace clippy/tests; checks each mutation causes an actual Rust assertion failure (exit 101);
builds both matched baseline and head freshly, builds TS dependencies through root pnpm/Turbo,
checks all tracked declaration tokens, and runs pnpm test:wasm-contract with the matched runtime.
The new WASM contract observes exact serial/sharded event order, complete columns and 4,103 ordered jobs.
The existing matched-runtime contract deeply compares events, cached-index meshes and styles.

All three patches reverse-apply. Extracted workflow steps pass bash -n on BOTH heads.
The completing selector is FIRST after acceptance-harness-8112 and keys on added prepass_index.rs;
its added-file predicate also matches against the structural branch, surviving its future squash merge.
Cheap checks pass: TS module size, Rust API surface (726 items), test wiring, source assertions,
reference-walk guards, float sorts, changeset names and license headers. No new parity exceptions.

## Earlier fleet outcomes and storage

All runs used the same absolute cwd through ifc-fleet; the exact phases are the checked-in recipe above.
`auto-b36c3a8cdeea4fbcbe6f2ccfa8950d20` at e330204b24: focused c4_11 tests, six passed (catalog allocation fixtures absent then).
`auto-fe6892ef440b4b2583c03d939a6fd3c7` at d62a75ad17: native stopped on two clippy borrows, fixed at b02a8108e0.
`auto-a0331bbf508946bdb18c1590a99ba868` at b02a8108e0: storage job-open refused before project start.
`auto-ffae4ffb8e5e482c8a2a9e456d232afe` at b02a8108e0: wasm builds passed; missing renderer dist stopped contracts; root Turbo deps added.
`auto-35c485a8360447ce957929639e89651c` at e7fb5615d3: clippy passed, workspace stopped on fixture-read policy; fixed with testkit at 3d5c31764b.
`auto-6b37d6f12d5347fa83514fe93a9e2377` at 12c79d8adf: refused before project start while original evidence publication was pending.
The original f25b receipt was reconciled and publication verified; only after the task returned active was e928 submitted.

Both tasks are closed and all seven completing-job evidence manifests are verified.
Registered reclamation removed the structural checkout (942,592,000 reported bytes) and two completing
checkouts (1,885,229,056 bytes): 2,827,821,056 bytes total. Five released checkouts (10,775,625,728 bytes)
remain protected. Reclaim stopped at unclassified generated packages/wasm/pkg-diff/.gitignore;
the storage classifier pins an older build-recipe digest. Some older checkouts also retain tracked generated
declaration changes, whose exact bytes are now committed. Released snapshots were preserved for owner
reconciliation; no classifier/metadata guard was changed and no manual deletion bypassed it.
Shared caches, fixtures, original receipts and foreign work remain untouched. Final clean receipt hash:
cf4922054298a3be7f0f34bdd2914a6e0118688f20ce6e38502de1ad9557a360.
