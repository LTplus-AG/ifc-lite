# Executable Copy revert witness

Source `95390b2bf004513f6a197c507abe188d55cfec2c` changes only the deep Copy test (6 insertions, 4 deletions). It uses the pre-existing `copyProductInStore` / `createCopyContext` API instead of the newly added batch wrapper. The batch wrapper calls this same canonical writer. Every 5,000-level fixture, 5,005 unique GUIDs, 5,000 aggregate relationships, complete hierarchy mapping, opening/filling counts, native mesh cardinality, displacement assertion and finite 300-second deadline is retained. Public routing and batch atomicity remain covered by their separate controls.

The real synchronous writer call is wrapped in `not.toThrow`, so the old recursive implementation's stack overflow becomes an attributable assertion failure. This is a behavior witness, not an API-presence assertion. No production, gate, selector or exemption changes.

Qualification on the exact source passes root typecheck (111 tasks, all 3,367 test files) and the forced six-file Copy cohort (31 controls, zero skips). These are Copy-layer execution scopes, separate from the earlier integrated final-layer qualifications.

The unchanged official **full-production-revert** oracle against actual main `0256886c10ec0a1dd81eded6f8e6f57914727d68` selects nine production paths and six changed test files. All **34 baseline controls pass**. The canonical deep writer control then produces **one genuine assertion failure** after production is reverted; both measurements are attributable to the same test file. The official verdict is **OBSERVED**, exit 0, with verified restoration. A separate forced root-Turbo run under the identical nine-file revert retains the exact `not.toThrow` failure receiving `RangeError: Maximum call stack size exceeded`; its source is restored afterward.

Other reverted suites cannot load removed new modules, and the reverted viewer file reaches the existing 600-second bound without subtests. Those are documented capability limits, not behavioral witnesses. The authoritative ledger accepts the genuine deep-writer assertion witness before considering those unrelated collection failures; its code is unchanged.

Runtime before/after remains WASM `7d63d9bc94333f10c4044eac3f70bd86bf361b98659ff5e6cb1161def46f597b` and JS `4719403c55b6061b7ff3ba260ae45783c4db846cb70ccd70ac51d5b03d87373d`. All original raw logs/JSON and hashes are retained losslessly in `archive.json`. Earlier batch stress and deadline receipts retain their original source identities in `../copy-stress-deadline/`; they are not relabelled as this writer run. Browser production and receipts remain unchanged.

Rerun the official oracle from a clean throwaway checkout of the qualified source, with declared dependencies, built workspace artifacts and matching runtime prepared:

```sh
node scripts/check-test-revert-oracle.mjs --base 0256886c10ec0a1dd81eded6f8e6f57914727d68 --ci --json
```

Run normal typecheck/tests through root Turbo. Fresh published-head CI and complete feedback remain mandatory before merging.
