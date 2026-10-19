# Canonical geometry stack layout repair — source checkpoint

Parent source: 8e64b4b0196084ec351be64ca5abf774c5731742.
Frozen failing validation source: edaefca319eca033ffb172b9cfeaf8df789c477e.
Original job: 5e4e16e3-568d-4cb1-a7d4-68d5432c78de, unchanged original request/receipt/log.

## Observed compiled evidence

Read-only DWARF inspection of actual frozen-source geometry test binary:
`/home/louistrue/build-workers/worker-state/targets/3b5868fcc2c2bd657d2c/debug/deps/ifc_lite_geometry-cd70c5cf6ed8d9b6`
SHA256 a1a6202af4522235b2383459e4616ee79c724c87e7d770df1f13543d4e241aa6.

Byte sizes:
- GeometryProgram 34,528
- ProgramReply 34,592 / ReplyValue 34,544
- ProductRootAdapter 13,264
- ProductMachine 6,944
- BooleanControl 5,040 / MappingControl 4,560
- OpeningAdapter 2,880 / LayerControl 1,776 / VoidControl 1,712 / CacheControl 1,712
- Common ReadyOperation 2,064 / ReadyPayload 2,016

Actual disassembly stack-probe minima (not full-frame totals):
- GeometryProgram::execute_with_inputs, address 0x6c5610, subtracts 0x1a000 (104 KiB) probe span.
- ProductRootAdapter::execute_with_inputs, address 0x10b3170, subtracts 0x23000 (140 KiB).
- ProductSource::execute, address 0x1215b50, subtracts 0x10000 (64 KiB).

This is direct evidence of excessive inline state and call frames, not proof that every recorded overflow has only this cause. GeometryProgram sums eight inactive optional controller layouts. ProductSourceReply::Child embeds a GeometryProgram by value, propagating its size through ProductReply, ProductAdapterReply, ReplyValue, ProgramReply and processing WorkReply. Even a basic product traverses these nested envelopes.

## Source repair

Only selected controllers get owned Box storage at their original activation points. Inactive alternatives remain None and allocate nothing. All existing calls, source/ready separation, tickets, callbacks and cancellation/drop ownership are unchanged. No stack setting, walker guard, fixture oracle or geometry arithmetic changed. Controller storage now incurs one heap allocation per actual activation; performance needs qualification.

Owned changed paths:
- rust/geometry/src/program/inner.rs
- rust/geometry/src/program/inner_entries.rs
- rust/geometry/src/program/inner_boolean.rs
- rust/geometry/src/program/inner_stack_tests.rs (new)

Tests added, UNRUN:
- 4096-byte inline ceiling for GeometryProgram, ProgramReply, common ReadyOperation, grounded in their repeated protocol-call crossing.
- Actual public-router one-block IFC wall product on explicitly ordinary 2 MiB native thread.
- Same real product through 24 valid mapping levels, below existing maximum 32, asserts complete 12 triangles and exact block bounds.

Parser (rustfmt emit stdout with skip_children, no source formatting) and git diff --check PASS. Compile, behavioural tests, updated DWARF/layout sizes and failing consumer reruns remain UNRUN. Fleet Pop refuses guard78; PC/Mac disabled. No heavy reservation submitted, original active job/source/artifacts untouched.

## Required qualification

Once admitted and original job terminal: run actual geometry tests including stack witnesses, processing/export/FFI tests that aborted, workspace tests and all-target Clippy. Confirm all three inline sizes and compare actual stack probes from corrected binary. If overflow remains, inspect real backtrace/call chain; do not increase stacks. Existing 256 MiB dedicated geometry-pool policy was untouched; ordinary test/unknown worker failures must not be hidden by routing tests there.
