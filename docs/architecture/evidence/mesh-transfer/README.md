# Registered mesh-transfer foundation (#4381)

This slice adds native/WASM planning, not a new UI command or a measured real
scan registration. It composes a registered opaque image observation over the
existing target appearance through the same atlas and IFC material planner used
by finite pages. Gaps remain explicit unknown observations.

The [independent run](oracle.json) invokes actual rebuilt WASM, applies its typed
mutation plan through IfcOpenShell, serializes/reopens IFC, checks independent
geometry, decodes PNG with Pillow and evaluates UV/color samples with NumPy.
The controlled 1 m triangle has a smaller observed triangular patch. Four source
image quadrants distinguish U/V orientation; an uncovered point retains its
explicit original RGB. The source is a declared invariant fixture, not a real
scan/IFC pair. Five interior/background samples pass a 0.025 normalized-channel
ceiling; the actual worst delta is recorded in JSON.

Native invariants additionally reject thin-wall look-through, overlapping source
faces and UV-seam ambiguity, while allowing continuous shared edges. They check
partial coverage area accounting, real IFC/PNG reopen, missing/stale identity,
unsupported alpha/tint, reflected placement, changed pixels and exhausted work.
The actual WASM contract repeats coverage, payload binding, no-applicable-plan
and refusal checks. Existing page composition tests protect source appearance,
previously applied pages and material properties through the shared refactor.

Reproduce after `bash scripts/build-wasm.sh`:

```sh
cargo test -p ifc-lite-processing appearance::transfer --lib
pnpm test:wasm-contract
python3 tools/texture-authoring/mesh-transfer-oracle.py
```

The oracle needs IfcOpenShell, Pillow and NumPy installed locally. It does not
fetch assets or provide an application IFC writer. Browser acceptance, source
lease/frozen-frame wiring, ordinary Apply/Undo/export/share and real distributed
held-out correspondences remain separate gates under #4381. CRAS plane-support
evidence does not supply those missing correspondences.
