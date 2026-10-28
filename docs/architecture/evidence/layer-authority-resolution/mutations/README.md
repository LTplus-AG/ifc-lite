<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Layer authority resolution: surgical mutation evidence

`packages/extensions/src/authority/` is new. The CI revert oracle (`Changed tests observe production`) reverts production by deleting it, so `authority.test.ts` fails to load, no assertion runs, and the oracle reports `REVERT-BROKE-BUILD` / INCONCLUSIVE. Each behavioural decision below was checked with a surgical mutation instead.

Each patch is written mutant→fixed (the orientation of `git diff base...head`), and the oracle reverse-applies it. All rows were captured at head `2574d8df4` against `origin/main` `545ac30b3`. Every run ended `OBSERVED` (exit 0) with restoration verified. The full result records are in `summary.json`.

| Patch | Module | Mutation | Test that went red |
|---|---|---|---|
| `shown-strongest-authoritative.patch` | `resolve.ts` | contested/authority-split show the stack-order winner instead of the authoritative value | `authority.test.ts` |
| `split-before-contested.patch` | `resolve.ts` | authority-split is never detected (row 4 falls through to row 5) | `authority.test.ts` |
| `dissent-outside-role.patch` | `resolve.ts` | authoritative opinions are counted as dissent | `authority.test.ts` |
| `signature-required.patch` | `resolve.ts` | unsigned opinions count as authoritative at trust level 3 | `authority.test.ts` |
| `no-rule-divergent.patch` | `resolve.ts` | ungoverned disagreement is reported as agreed | `authority.test.ts` |
| `unconfirmed-row.patch` | `resolve.ts` | a governed attribute nobody in the role spoke on is not unconfirmed | `authority.test.ts` |
| `canonical-key-order.patch` | `resolve.ts` | object values are compared by key order | `authority.test.ts` |
| `exact-type-beats-glob.patch` | `charter.ts` | glob type outranks exact type | `authority.test.ts` |
| `same-role-not-ambiguous.patch` | `charter.ts` | same-role overlapping rules are rejected as ambiguous | `authority.test.ts` |
| `disjoint-types-not-ambiguous.patch` | `charter.ts` | rules on disjoint types are rejected as ambiguous | `authority.test.ts` |
| `constraints-fail-closed.patch` | `charter.ts` | tag constraints match the wrong entities | `authority.test.ts` |
| `set-covers-members.patch` | `attribute-path.ts` | a set target no longer covers its members | `authority.test.ts` |
| `xformop-is-placement.patch` | `attribute-path.ts` | usd::xformop is treated as geometry instead of placement | `authority.test.ts` |

## Replay

Use a clean checkout of the branch with workspace packages built. Copy the patches outside the tree, because the oracle refuses a dirty tree. Then run, for example:

```bash
node scripts/check-test-revert-oracle.mjs --base origin/main \
  --only packages/extensions/src/authority/resolve.ts \
  --test packages/extensions/src/authority/authority.test.ts \
  --mutation /tmp/authority-mut/split-before-contested.patch --ci --json
```

The other runs use the same shape, with `--only` set to the module in the table.
