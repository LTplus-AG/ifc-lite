# Schema conversion (#7683, PR #7736)

`schema-convert.oracle.patch` is the revert-oracle mutation for the schema-conversion half of #7683. It is applied by the step "Prove the changed tests observe the production change" in `.github/workflows/test.yml`.

Why a mutation: the PR deletes `schema_pad.rs` (whose `#[path]` test file it also deletes) and adds `schema_plan.rs`, `schema-converter-product-proxy.ts` and a `StepStats` field that the changed tests use. A whole-change revert cannot build the Rust `--lib` runners, so in CI the Rust schema-conversion change was observed only through the TypeScript twin. This patch keeps every new item and disables ONLY the behaviour the tests pin:

| finding | behaviour disabled | Rust | TypeScript |
|---|---|---|---|
| EXPORT-MERGE-8 | the alignment proxy keeps attributes 1 to 6 | `product_proxy` writes the bare placeholder | `productProxy` writes the bare placeholder |
| EXPORT-MERGE-1/2/9 | trim/pad by the name-prefix rule in both directions | trim only IFC2X3 targets and only IfcWall/IfcDoor; pad only non-IFC2X3 targets (main's shape) | n/a (TS already had the rule) |
| loss counter | `attribute_values_dropped` | not incremented | n/a |
| D3 parity | an IFC2X3 target refuses a type its table lacks with no source entry | n/a (Rust already did) | old `srcAttrs && …` condition |
| EXPORT-MERGE-12/18 | span folds, last-wins index | `merged/{mod,plan,single_parents}.rs` back to main | n/a |

Once `rust/export/src/schema_plan.rs` is on `main`, the ordinary whole-change revert resumes automatically, because the `elif` matches only while the PR adds that file.
