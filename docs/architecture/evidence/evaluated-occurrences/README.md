# Mapped occurrence conversion evidence (#4404)

[Integrated viewer acceptance](viewer-acceptance.md) records real image/PDF
preview, repeated Apply/Undo/Redo, federated visibility and export/reopen picking.

The real IFC4 AC20-FZK-Haus fixture comes from `tests/models/manifest.json`.
The test selects IfcMember 35169, one of 42 type-related members, and applies
image appearance through the native evaluated-occurrence policy. The only
changed pre-existing STEP entity is its occurrence Body wrapper 35155. All
unselected canonical meshes compare exactly; the selected mesh retains every
oriented world triangle corner and gains the new texture/UV mapping.

`independent-reader.json` comes from IfcOpenShell 0.8.2 reopening the actual native
plan export. There are zero new schema violations relative to the source's 170
existing findings. Its 12 triangles and world vertices match the native source;
the largest nearest-corner difference is below one micrometre. This is an IFC
interchange/identity check, not a claim of viewer mouse-selection acceptance.

Reproduce with the real fixture and generated native artifacts:

```sh
IFCLITE_EVALUATED_EVIDENCE_DIR=/tmp/evaluated-evidence cargo test -p ifc-lite-processing \
  appearance::evaluated --lib
cargo run -p ifc-lite-processing --example evaluated_policy_probe -- \
  tests/models/ara3d/AC20-FZK-Haus.ifc 35169 59290 > /tmp/evaluated-evidence/native-original.json
python3 docs/architecture/evidence/evaluated-occurrences/verify-native-plan.py \
  tests/models/ara3d/AC20-FZK-Haus.ifc /tmp/evaluated-evidence/native-planned.ifc /tmp/evaluated-evidence
```

The native tests also cover finite PDF-page atlas composition, shared Body
refusal, direct and aggregate-propagated opening refusal, and failure atomicity
when normalization succeeds but subsequent image mapping fails. Opening-bearing
conversion remains disabled; a prototype exposed representation semantics that
must be resolved in a later slice. The current scope and constraints are in
[the representation policy](../../appearance-evaluated-occurrences.md).
