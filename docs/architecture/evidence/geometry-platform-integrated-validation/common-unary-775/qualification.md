# Qualification state

Status: **UNCOMPILED / UNRUN**. Source inspection and Rust syntax parsing are the only local checks. No numerical correctness, target parity, final product, performance or preservation verdict is claimed. Parent-reported native SDK qualification remains red; the implementation does not change numerical methods or repair that failure.

## Performed lightweight checks

- Read root/rust AGENTS instructions and fleet policy. Fleet metadata: Pop reachable with admission refused (guard 78), PC/WSL reachable with admission allowed, Mac disabled. No validation job was submitted.
- `git diff --check`: clean at final source review.
- Changed Rust files parsed with `rustfmt --edition 2021 --config skip_children=true --emit stdout`, discarding stdout. Exit 0. No files were formatted, compiled or executed. This does not establish Rust type correctness or Clippy success.
- Inspected the exact Difference clip/guard, generic Intersection unsupported handling and the primary buildingSMART AgreementFlag definition. Source/reference hashes are in `source-files.sha256`.

## New witness source awaiting parent execution

`geometry/program/retained_clip_tests.rs` covers fixed raw source provenance, metre/survey frames, typed residuals without boundary reach, original Empty slot/lazy second operand, oblique normal plus rotated input covector identity, and physical reflected/nonuniform bake before unary clipping. Injected Empty there is explicitly control-only, not numerical evidence.

`processing/element/session_retained/clip_tests.rs` and `clip_browser_tests.rs` use actual decoded STEP and sealed SDK/module Worker outputs. They cover both AgreementFlag values and modes at off-centre z=1 in a height-3 area-8 host: signed z bounds, signed volume, volume centroid and complementary volume 24. Difference also executes the unchanged exact source operation through a separate decoder/router and compares those observables. Intersection follows newly admitted IFC semantics; it is not compared against an imaginary existing exact clipping branch.

Further test source covers actual Intersection Empty at z=-10, healthy Difference Empty compatibility hold at z=10, intact original tickets/replies, independently sealed wrong-frame and signed-zero coefficient receipts, source epoch/owner staleness, captured resource cancellation/refusal before the Difference Empty hold, immutable source survival and mapped Clip inputs feeding unary/binary selectors. No public fake receipt constructors, numerical replies or coefficient buffers are used as numerical authority.

Both targets include committed issue #5314 edge-grazing source and its existing authored prism integral (scaled to metres). Native additionally includes optional AC20-FZK-Haus roof-wall occurrences #67536/#75347 and the existing positive-volume invariant. Missing native SDK/optional fixture explicitly skips; skipped coverage must not count as passing. Browser qualification requires actual installed module assets and fails when unavailable. All these witnesses are UNCOMPILED/UNRUN here.

## Required integrated work

Parent must apply its runtime prerequisite and accounting corrections, compile both target projections, run the new real-source SDK/Worker cases, original exact regression cases and required root/workspace checks via fleet policy. Resolve SDK qualification red before interpreting test results as numerical evidence. Run strict Clippy; the packet boxing correction has only source-level review. Review first-fault ordering and memory admission together with the parent's retained ownership work.

Missing execution evidence includes asymmetric oblique cuts on actual box/cylinder/rational inputs, tangency/coincidence, negative/nonuniform physical SDK mapping, real model native/browser parity, source/frame mutation ordering, SDK domain/memory ownership, installed wasm type/runtime assets, cancellation/release/restart behavior beyond the added cases, exact determinism/reference gates and end-to-end base/branch perf. No benchmark was run; perf verdict is unmeasured and required before a perf-sensitive PR is ready.

Difference-to-Empty legacy compatibility, polygonal/boxed halfspaces, unbounded Union, paired splits/layers, openings, appearance, persistent face ancestry and complete final product assembly remain explicit holds. They must not be removed from remaining requirements or counted as completed by successful unary clipping. Source-specific review can assess the continuation/transaction design; merge, runtime and product readiness remain unqualified.
