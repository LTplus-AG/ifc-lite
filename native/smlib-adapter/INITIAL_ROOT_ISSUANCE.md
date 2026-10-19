<!-- SPDX-License-Identifier: MPL-2.0 -->
# Reviewed first-issuance correction

Additive to frozen `9d5dc61e56f55e06e948285ae23f61e671b898b1`.
The independent P2 review found that every observed constructor already had a
binding, while root admission rejected all existing bindings.

Private `Phase::InitialConstruction` marks a trusted adapter construction phase.
A face's real constructor notification records its current generation and phase.
Before that same phase ends, complete-inventory first issuance may accept its
incomplete constructor node, or the single initial `ADD_TO_BREP` child emitted
by public `MakeFaceTopology` (`SmBrep.cpp:14824`). These are initialization
events, not authored IDs. Ordinary mutation phases never grant this eligibility.
`SmFace::SetSurface` (`SmFace.cpp:10060–10095`) distinguishes an initial
attachment from replacement using its actual old-surface notification argument.
Replacement or PRE/POST editing removes eligibility. Removal/trimming/repeated
addition, roots, copies, splits, merges, retirement and expired phases cannot
receive a new initial root. All resource and inventory preflights still precede
root issuance. No callback gap is introduced; historical addresses never supply
an ancestor or an issuance credential. A new constructor is a new generation.

The follow-up review found that an attached surface's notifications followed
the geometry-owner branch instead of the face-caller branch. That branch now
also revokes initial eligibility for PRE/POST edit, geometry change, split or
merge. Existing complete histories latch unsupported geometry change, including
PRE_EDIT. An actual `SmPlane::TrimWithDomain` call after surface attachment and
before admission must refuse first issuance, even with the same domain. The
unchanged real generated-patch positive control must still admit and copy its
first generated root. These actual SDK witnesses remain UNRUN.

This phase is internal trusted construction authority, not proof that an
arbitrary SDK constructor or geometry producer succeeded. The caller must check
each construction status and the callback latch before root admission, supply
the independently issued live object/operation revision, and never use it to
relabel earlier geometry with lost ancestry. Parent runtime sealing is still
required. Root kind retains source boundary versus generated interface.

The sixth independent CTest gains actual generated planar-patch construction
inside the continuous observer, first generated-root issuance, checked copy,
root binding/lifetime verification, and missing/duplicate, copied/relabelled,
ordinary unknown construction, expired-phase and edited-history refusals.
These witnesses are **UNRUN**. C++17 syntax-only parsing passes against the
immutable pinned SDK; this is not numerical or callback-coverage qualification.

The owner-chain observer additionally follows a documented `SmEdgeuse` to its
edge, so UV trim geometry changes cannot evade the existing established-geometry
refusal through an unrecognized owner type. No mutation guard is weakened.
Checked extraction and complete paired intersection/classification remain
separate pending work. No public opcode, capability, root wire or persistent
face authority is added.
