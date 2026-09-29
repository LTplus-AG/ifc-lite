# Viewer nominal source quantities: mutation proof (#6433)

`nominal-volume-mutation.patch` is oriented from an incorrect square unit
conversion to the shipped cubic conversion. The revert oracle reverse-applies
only this line in `SourceQuantityInspection.tsx`, keeping the new component and
its test imports intact. With the mutation, an IFC extrusion authored in
millimetres displays its nominal volume 1,000 times too large; the mapped-source
assertion expects the correctly converted `2 m³` value.

Run from a clean checkout at the stacked PR head:

```sh
node scripts/check-test-revert-oracle.mjs --base 3fe909341 \
  --mutation docs/architecture/evidence/viewer-source-quantities-6433/nominal-volume-mutation.patch \
  --ci --json
```

The oracle reports `OBSERVED`: the baseline passes 7/7 quantity tests; the
mutation leaves six passing tests and one assertion failure. It then restores
the production line and verifies `git status --porcelain` is empty. This patch
is review evidence only; normal builds and tests do not apply it. A whole-file
revert removes the newly added component and breaks the test import before an
assertion can run, so the surgical mutation is needed for this branch.
