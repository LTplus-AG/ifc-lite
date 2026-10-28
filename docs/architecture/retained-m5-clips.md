# Retained plane clips (M5, #7955)

A Difference with an `IfcHalfSpaceSolid` uses CUT-0's finite prism in the
host evaluation frame and the ordinary retained Boolean executor. Union and
Intersection refuse. `AgreementFlag` uses the exact plane reader unchanged.
A bounds-proven kept-side clip emits no cutter or Boolean. Mapped operands
use the existing affine bake before clipping. A certified empty Difference
refuses the whole product; the original host is never published instead.

## Scope amendment, 2026-10-28

The orchestrator's Round 2 task message explicitly authorized a minimal shared
result/provenance hook in `program/boolean/retained.rs`, plus a trailing
`FailureSite::HalfSpaceClip` and the transaction error match. This amends the
M5 spec's frozen CUT-0 Boolean file restriction; no non-halfspace Boolean
behavior is intended to change.

The hook is `arm_step_result(site: FailureSite, entity: u32)`. It is armed only
when halfspace dispatch returns `Cutter`, not on `Skip`. `retained_solid`
attaches the Difference's logical result, whose numerical outcome is shared
with the executor. `check_step_result` runs at the next spine continuation,
before popping a node or decoding another operand, including after the final
clip. A certified empty outcome preserves the halfspace id and yields
`halfspace_clip` / `consumed` / `empty_result`. This same hook already covers
bounded/boxed cutters once M6's dispatch stubs return a cutter; M6 can choose a
different failure site at the arming point without changing the mechanism.
The hook does not create an empty certificate or interpret an unbound outcome
as empty; authentication remains the executor's responsibility.

The preregistered tolerance file is `tolerances.d/m5.json`, as requested in the
Round 2 task (the original spec called it `m5-clips.json`). No existing
threshold was changed. Test-generated minimal STEP fragments are synthetic
controller invariants; they are not authored-corpus or independently reviewed
fixture qualification.
