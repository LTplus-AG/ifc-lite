<!-- SPDX-License-Identifier: MPL-2.0 -->

# Internal S1 construction contract (#7955)

This is crate-private implementation documentation, not a published API.
The first cross-crate consumer (S4a) must review and qualify any exposure.

The internal `RetainedProgram::product_parts` drives the existing
product traversal in an explicit retained mode. Supply a `RetainedContract`
with the source epoch and revision, then use `request`, `admit` and `accept`
with the same decoder and router. Admission returns logical construction
operations; exact numerical execution refuses those operations without consuming
them. A foreign reply is returned intact and does not advance the receiver.

This increment admits direct extrusion and swept-disk recipes, preserves
repeated occurrences and recorded STEP ids, and checks proper-rigid product
placement. Absent ObjectPlacement follows the exact identity fallback; its
Product stage records traversal, not proof of an authored placement. Selected
items from unsupported source families, including mappings and Booleans, refuse
the traversal; custom processors, annotations and alignments
remain unsupported. A duplicate mapped representation skipped by the canonical
selector is not admitted or evaluated. Native targets support source
capture; wasm32 needs the existing `wasm_source_capture` feature. The default
wasm build refuses retained admission.

The root must be an `IfcProduct`; a real product with an absent (`$`)
`Representation` may produce an empty construction plan. Retained admission
checks every authored `Representations` and `Items` list before representation
selection. Lists must be nonempty and contain only reference tokens. Every
representation reference must decode to `IfcShapeRepresentation` or
`IfcTopologyRepresentation`; every authored `Items` reference must decode and
belong to `IfcRepresentationItem` through the generated supported-schema type
hierarchy, including legacy subclasses. Dangling references, decoding failures
and wrong categories refuse the whole plan even after a valid first member or
inside a skipped Axis, Topology or duplicate Mapped representation.

This is shallow list, resolution and category validation, not complete EXPRESS
schema validation: it does not certify declared-schema conformance, each
representation type's item constraints, or the attributes and child references
of unselected items. Normal selection still applies. In particular, unselected
mapping sources/targets are not traversed, and a successful Body-only plan does
not certify their semantics or complete the product. Category membership does
not enable additional retained constructors or topology families; selected
unsupported items still refuse. The exact path keeps its existing decoding and
selection behavior. Composed retained frames must remain finite,
including initial unit conversion; failed composition leaves the logical value's
frames, occurrence slot and placement lineage unchanged and refuses the plan.

`finish` returns a logical `RetainedProductPlan`, not a completed mesh or a
runtime receipt. Opening closure, material layers, appearance and persistent
face identity remain conservatively unchecked, even when no relationship is
visible in the direct representation. Only a consumer that proves an obligation
unnecessary or discharges it may remove it. It grants no source execution
authority, performs no SDK work and publishes no partial retained product.
The native/browser transaction consumers, full release features and explicit
viewer/CLI selection follow separately;
exact geometry remains the default.

S1 has the following construction-only trust boundaries. They are limitations
of this increment, not fulfilled delivery guarantees:

- The caller must obtain the root from the same source/decoder used for every
  admission and supply matching epoch/revision labels. Those labels are caller
  assertions, not authenticated source identity or execution authority. S1
  binds a decoder/router on first admission and rejects later foreign owners;
  it does not authenticate the supplied root against that first decoder.
  Preserving a STEP id tests record identity, not source authentication. An
  execution consumer must establish source coherence before relying on labels.
- Resource checks and charges use the current ambient account. Callers must
  keep `request`/`admit`/`accept`/`finish` in the same resource scope and discard
  the program after a stop. Explicit `cancel()` is sticky; an ambient stop is
  not latched by S1, and resuming outside the scope or in another account is
  not prevented. S2 must establish an owning resource context and terminal
  stop before execution. The current tests do not certify cross-scope
  ownership, bounded capture memory or complete resource accounting.
- The facade currently carries source refusals as geometry-error strings at
  `finish`; `RetainedProgramError::Unsupported` does not encode every product
  refusal. Default wasm reports unavailable retained capture as `Unsupported`.
  A typed, listed product-refusal boundary must be defined and tested before
  delivery or downstream consumers rely on this API. Delivery must show an
  explicitly incomplete model load, publish no partial geometry for a refused
  product and perform no silent exact substitution. S1 does not satisfy that
  contract. A1t typed source/product errors remain required with S4a, before a
  consumer relies on the facade; never match diagnostic strings.
- `RetainedProductPlan` is internal data: its crate-private `values` and
  `remaining` fields can be edited. Logical values require charged `try_copy`;
  neither values nor operations implement `Clone`. Clearing an
  obligation list cannot certify openings, layers, appearance or persistent
  faces. An execution consumer must validate its own completion state; neither
  the plan nor an empty `remaining` vector is a completion certificate.

These review corrections require reached-fixture red/green tests, independent
guard mutations and fresh review before acceptance. They do not qualify SDK
execution, native/browser transactions, performance, full release features,
viewer/CLI integration, licensing, or deployment, and do not complete #7955.

Process-local program/slot identities depend on allocation history and thread
interleaving. Never serialize them, sort output by them, or compare them across
runs. They are not persistent source or face identity.

Numerical admission preserves the original typed ProgramStop and checks stops
before taking the reached operation. Source execution returns its owned reply
even if that execution stops: acceptance rechecks and returns the reply intact
with Stopped. There is no fallible post-consumption check that discards it.
This is construction bookkeeping, not a publication linearization guarantee.
An empty construction plan still carries all four unchecked obligations; it is
never evidence of a complete-empty product or model.
