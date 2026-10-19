# P2 independent coverage response

The cancelled-backend lifetime case did not independently establish missing-work mutation refusal. This tests-only follow-up adds three fresh healthy-backend cases after frozen 0f67f3016def860f7f4f10984af766016a2a90cd; no production defect is presently identified.

Each case creates storage under actual authenticated decoder work, returns from `run` so that the original work, source scope and decoder are destroyed, then performs cleanup-only take/replacement into an empty destination. No destination work is created. Backend `check()` must succeed immediately before the mutation attempt.

- `p2_healthy_cleanup_handoff_refuses_spare_capacity_push_without_destination_work`: a real Vec has explicitly reserved spare capacity; push must return Coverage and preserve its slice, pointer and capacity.
- `p2_healthy_cleanup_handoff_refuses_occupied_replacement_without_destination_work`: a real hashbrown map retains spare capacity and an occupied key; replacement must return Coverage and preserve the value, length, occupied slot address and capacity.
- `p2_healthy_cleanup_handoff_refuses_prereserved_insertion_without_destination_work`: a real hashbrown map has successful explicit reserve and no tombstones; insertion of an absent key must return Coverage and preserve both lookups, length, occupied slot address and capacity.

All cases compare every live/storage/work/copy/peak/refund/observer counter and the violation flag before versus after refusal. Only the fixed terminal bridge may change to Coverage. Cleanup take/drop must still complete with zero live and observed bytes and no refund ordering violation.

The spare capacities remove allocator callbacks as the enforcement mechanism. Statically, removing Vec operation admission permits a spare-capacity push, and removing map entry admission permits occupied replacement, violating the new assertions. New-key insertion has two existing nonallocator admission checks (entry and work/copy pre-admission); deleting only one correctly remains covered by the other. Removing its operation admission checks permits the pre-reserved insertion and violates the new assertions. No mutant was executed, and no claim is made that deletion of a single redundant check must fail all three cases.

All compilation, behavioral execution, mutation execution, Clippy and performance qualification are UNRUN. No build/test/heavy submission or GitHub action occurred. Parent owns validation. R2/R3/R4 artifacts were checked against their existing SHA256SUMS and remain unchanged. No prototype activation, production code, parser, Raw API, public migration or authority contract was changed.
