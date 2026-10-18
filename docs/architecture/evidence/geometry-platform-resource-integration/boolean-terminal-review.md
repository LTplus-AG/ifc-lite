# Boolean resource integration static review

Result: no concrete compile/privacy/borrow/move blocker or currently reachable terminal-to-recovery conversion found in the inspected Boolean integration. This is read-only static inspection, not Rust type validation: no Cargo, rustc, parser validation, numerical run, fleet submission or source edit was performed. Pending source/cache delivery was not applied or presumed present. Processing publication fixes remain independently owned and are not qualified here.

## Reviewed terminal flow

- `program/boolean/mod.rs`: every dequeued frame and the final completion check the resource terminal. A returned stop takes the same explicit active-membership cleanup as other errors, preserving caller ancestors and monotonic visits. Popping a queued exit before observing a stop does not strand the membership: the `active` cleanup still removes it. The existing unwind restoration guard was not changed.
- `batch.rs`: collector admission is observed before base evaluation. Preparation preserves ordinary source-fault deferral, while typed stop is returned before provisional rewind. Prism execution effects are assembled before observing its result. After group numerics, a latched terminal assembles reached numerical effects and returns before `assemble_group` can rewind. A returned `Err(ProgramStopped)` also cannot trigger the `Ok(None)` rewind condition and is promoted by `observe`.
- `step.rs`: operand/plane optional recovery is followed by a terminal check. Bounded-prism admission and numeric results distinguish typed stop from the historical source/numerical fallback. A stopped single cutter is checked after effect assembly and before any plane fallback. Unit discovery remains reached only after successful prism construction or actual solid-kernel admission. Unknown operator handling still precedes dormant SecondOperand reads.
- `operand.rs`: lowering is checked before numerical execution; owned work is observed before void processing. Void shells retain per-shell lower/evaluate interleaving and stop checks before later shells, final unit discovery and subtraction. Typed stop is not converted into a fabricated shell-source-loss record.

## Type and privacy inspection

`core::resource_stop::ProgramStop` implements Display/Error via thiserror, and the core module is public. Therefore the transparent geometry Error variant and derived From conversion have the required visible source type. No internal exhaustive match over the complete geometry Error enum was found that omits the new variant; uses of individual variants found by search are constructors or nonexhaustive tests/if-let patterns.

The changed private test adapters consistently return `Result<Value>`. The three call sites in `brep_void_plan_tests.rs` unwrap the Result before destructuring. Method visibility is crate-visible under cfg(test), and `StepAdmission`/Execute/Completed remain visible within the Boolean child-module tree. The conditional `if let Err(error @ ProgramStopped(_)) = result { return Err(error) }` uses are followed only on nonmatching control flow; I did not identify a moved-value reuse there. These observations still require the coordinated real compile/test run.

## Consumer boundary scope

The Python wheel delegates geometry to the native ProcessingRequest/ProcessingResult consumer and formats its own supported errors generically; it has no direct exhaustive geometry Error match to update. Existing native jobs and WASM batch likewise consume canonical processing results rather than exhaustively matching geometry errors. The newly typed accounted Rust entry point explicitly handles `ProgramStop` separately. Existing compatibility-facing mesh-only boundaries do not thereby gain a new typed Python/JS terminal API. Their stop-publication behavior is part of the separately owned processing review/fix, not evidence that every public consumer now reports cancellation as an exception.

## Follow-up coverage, not discovered blockers

1. Add a grouped-cut regression that reaches actual group work, records a numerical failure, and stops before provisional deferral assembly. Assert reached numerical records survive, old provisional records are not rewound, no sequential fallback source is decoded, and visits remain spent. The current new tests cover a stop after an actual ordinary base and a pre-stopped void-shell child, not this specific group branch.
2. Add a prism/single-cutter terminal case that would otherwise reach plane fallback; assert no `PolygonalBoundedHalfSpaceFallback` diagnostic and no fallback work. Again, the current code checks this boundary, but new tests do not exercise it directly.
3. When the pending source layer starts emitting typed terminal errors, preserve their variants through two current erasers: `processors/boolean/operand.rs::half_space_plane_or_record` calls `.ok()`, and `polygonal_candidate.rs::collect_polygonal_chain` turns `Admission::Fault(Arc<Error>)` into `Error::geometry(error.to_string())`. In the current inspected delivery these source helpers produce core/source faults, not ProgramStopped, so I found no present reachable terminal conversion through them. The caller's `check_current`/`observe` catches a separately latched terminal, but that should not replace variant preservation if a future source adapter returns a typed error without already latching it.
4. Checkpoints are cooperative between frames/source admissions/numerical seams; this patch does not introduce interruption inside the unchanged source collector or exact-kernel numerical loops. Do not claim allocator coverage or kernel preemption from these checks.

## Snapshot identity

The accompanying JSON records SHA-256 of the exact inspected files. Parent processing files may continue changing independently; the hashes describe this static snapshot, not a full build receipt.
