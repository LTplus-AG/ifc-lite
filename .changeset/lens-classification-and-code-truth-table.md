---
'@ifc-lite/lens': patch
---

Pin `matchesClassification`'s `systemMatch && codeMatch` (`packages/lens/src/matching.ts:392`) with a truth table.

Test-only; no production code changed. The only existing test supplying both
`classificationSystem` and `classificationCode` (`'should match classification
by system AND code'`) gives a case where both match, which passes under `&&`
and under `||` alike — mutating the `&&` to `||` left all 165 tests green.
Three cases now cover the remaining rows: system matches but code does not,
code matches but system does not, and neither matches — each asserting
`false`, discriminating AND from OR.

Checked the sibling multi-field predicates in the same file
(`matchesProperty`, `matchesAttribute`, `matchesQuantity`, `matchesMaterial`)
for the same shape. None share it: each requires only one criteria field to be
present for its match logic (a `propertySet`/`propertyName` pair, a
`quantitySet`/`quantityName` pair, etc. are precondition guards, not two
independently-testable match outcomes ANDed together) — `matchesClassification`
is the only predicate here where two independently optional fields are both
matched and ANDed.

Not fixed here, flagged for the maintainer: the `exists` operator's
empty-string handling is inconsistent across `matchesProperty` (`''` counts as
present), `matchesQuantity` (`''` counts as present), and `matchesAttribute`
(`''` counts as absent) — documented in code comments as intentional but not
exercised by any test. Whether that asymmetry is intended is the maintainer's
call; a prior sweep judged it low severity and did not pursue it.
