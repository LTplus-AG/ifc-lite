# Viewer extrusion source inspection: mutation proof (#6432)

`basket-membership-mutation.patch` is intentionally oriented from a faulty
selection predicate to the shipped predicate. The revert oracle reverse-applies
it on the branch, leaving all new modules and imports in place. The mutation
admits a stale `selectedEntity` when the model-aware selection basket contains
another product; the `selected-source-products.test.ts` assertion must reject
that extra product.

Run from a clean checkout at the PR head:

```sh
node scripts/check-test-revert-oracle.mjs --base origin/main \
  --mutation docs/architecture/evidence/viewer-extrusion-6432/basket-membership-mutation.patch \
  --ci --json
```

The oracle reports `OBSERVED`: the unmodified baseline passes 11/11 tests;
reverse-applying this patch leaves ten passing tests and one assertion failure
in `selected-source-products.test.ts`. It then forward-applies the patch and
verifies `git status --porcelain` is empty. The patch is separate from
production and is never applied during normal builds or tests.
