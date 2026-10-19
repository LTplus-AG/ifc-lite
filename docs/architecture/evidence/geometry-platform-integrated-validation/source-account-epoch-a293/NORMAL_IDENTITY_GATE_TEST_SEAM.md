# Proposed bounded normal-type-identity end-to-end gate witness

Status: design only; NOT IMPLEMENTED or authorized production activation. This proposal is pinned to the repair commit in source-manifest.json and the 8af base. It addresses the explicit remaining coverage gap, not a new source-authority mechanism.

## Chosen seam

Add a distinctly named, explicit test-support feature to core, for example source-resource-gate-test-support, requiring source-resource-tracking. Under that feature, compile the SAME private source_resources gate/authority/allocator/container implementation into the normal core library. Default and ordinary tracking builds retain their existing gating. Do not duplicate the gate, implement a geometry-to-unit-core proxy account, or reconstruct an account from limits/usage.

Expose only one bounded witness runner under this TEST-SUPPORT feature. It accepts the original paired SourceResourceContext and an observer factory called with the runner's actual SourceStopHandle. The factory returns the already-funded AllocationObserverHandle made by geometry's real OwnedResourceContext::try_capture_accounted. It cannot return a replacement allocation projection. Gate construction independently checks matching paired account identity and actual decoder/work publication as today.

The runner creates a small fixed test SourceBundle fixture, takes its actual selected decoder, obtains its actual lease/work, publishes the supplied original context, invokes the observer factory inside that scope, and uses that SAME decoder/work through the private gate. This is actual normal-core test ownership, never an inspection decoder used to authorize production capture. It is not exposed as a loader or caller-selected decoder operation.

The runner returns a bounded plain report containing scalar observations/stops; it returns no decoder, gate, allocator, owner, cache, source receipt or execution capability. The runner's containers and scopes are created and destroyed internally, with explicit phases for a Weak-only survivor and final cleanup after work ends. A fixed-stage observation callback may read the real geometry account's usage/pool counters while each phase is live; it receives only a small stage enum, no owner handles. It has no account-selection/attachment role. No arbitrary production operation callback is accepted.

Geometry's existing test-support module calls this normal-core runner with its actual private-Inner paired context. Its observer factory captures the actual geometry OwnedResourceContext using the runner's actual stop. Geometry witnesses hold the real ExecutionAccount/ModelResourcePool and assert their usage, first faults and pool residency at fixed stages and final return. Opted-in core unit tests invoke those geometry witnesses as they do existing actual-account witnesses. The calls thus remain within the normal core type universe across geometry, while core's unit-test crate only invokes the witness by a scalar/no-handle interface.

## Owned paths and implementation coordination

- rust/core/Cargo.toml and rust/core/src/lib.rs: explicit test-support feature and private module cfg; pinned allocator/Vec API feature gates follow the new test-support cfg.
- rust/core/src/execution_owner.rs and source_resources/authority.rs: SAME safe authority implementation in normal test-support builds, with normal dependency-private projection comparisons available there. No new public authority constructor.
- rust/core/src/source_resources/{mod,gate,backend,...}.rs: only the minimum cfg split needed to compile the existing implementation in that build. Historical Budget/Resources, their four-gate quota, control-size printer and unit-only constructors/tests stay test-only. Avoid lint allowances by cfg-gating fixture-only helpers, not exposing tracked constructors.
- A small core test-support runner module and plain report/stage definitions, all reachable only with the explicit test-support feature. Private decoder/container constructors remain private even in this build.
- Geometry's manifest/test-support witness file and core's opted-in witness tests: feature wiring and actual account/OwnedResourceContext/pool assertions. No processing/ProductOwner/parser/cache/native/runtime files.

The normal test-support feature must be explicitly enabled by the parent validation command; merely enabling source-resource-tracking must not expose the runner or compile the private gate into a shipping library. Verify the feature/dev-dependency cycle and package graph before relying on the seam. The existing sixteen-frame/ancestor feasibility limits must be identified as test-only implementation limits, never production workload authority. Any cfg split that changes gate semantics needs separate review; no copy of the implementation is acceptable.

## Bounded actual-account scenarios

Use fixed small real Vec/map/Arc/Weak/Box owners, no arbitrary workload input. Demonstrate: actual source context downcast still identifies the original private account; live metadata and container categories share its allowance; private Gate admits real allocation in that actual account; original account costs change while a generous ambient account remains unchanged; full old/new growth overlap and failed live admission preserve backing/cumulative costs; owned source stop forwarding includes the fresh-epoch R1 regression; same-account sharing/Weak retention adds no allocation; work expiry denies spare-capacity mutation; final cleanup/refunds and pool release occur after actual backing release. No synthetic Budget can satisfy any of these actual-account witnesses.

Retain the existing unit-level observer/storage instrumentation for detailed allocator ordering, but do not substitute it for these real-account counters. Real Global OOM remains unforced and separately qualified. Existing owner/epoch/account baseline backing and complete cache/revision authority remain explicit limitations.

## Approval boundary

This requires an explicit normal-library TEST-SUPPORT exposure that does not exist at the repair checkpoint. Parent must coordinate/review that API/cfg change before implementation. It supplies end-to-end testing only; it does not authorize ProductOwner activation, a public tracked decoder API, original production source capture, raw/cache/COW/escape migration, or a completion/performance claim. No code for this seam is included in the P2 repair commit.
