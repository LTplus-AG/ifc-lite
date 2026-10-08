# 01: The tolerance formula the tests use is not the one the docs state

**Upstream:** buildingSMART/IDS#418 "Tolerance in 1.0" (open, milestone 1.1,
"discuss & decide"). **Lint:** IDSL-VAL-008 (real-number equality).

## The ambiguity

`Documentation/ImplementersDocumentation/tolerance.md` defines equality of a
real value `x` with an IDS value `v` as

```
(v - abs(v) × ε - ε) < x < (v + abs(v) × ε + ε),   ε = 1e-6
```

with strict comparisons. The official `tolerance/` test cases put values
exactly on those bounds and expect them to pass, so the text and the tests
disagree. #418 reports 12 failing official cases for an implementation of
the text as written, 2 with inclusive comparisons, and 0 with inclusive
comparisons plus bounds rounded to 15 decimal places (as the reference
implementation does). The last 2 are a one-ULP gap: the decimal literal
`1.000002` and the double `1 + 1e-6 + 1e-6` differ in the last bit.

## Minimal example

```xml
<property dataType="IFCLENGTHMEASURE">
  <propertySet><simpleValue>ProposedCases</simpleValue></propertySet>
  <baseName><simpleValue>Length</simpleValue></baseName>
  <value><simpleValue>1</simpleValue></value>
</property>
```

```
#10=IFCPROPERTYSINGLEVALUE('Length',$,IFCLENGTHMEASURE(1.000002),$);
```

The text says fail (1.000002 is not `< 1.000002`); the corpus says pass
(`tolerance/pass-comparison_tolerance_for_floating_point_one_upper_bound`).

## What ifc-lite does, and why

- **IDS 1.0 (default):** `|x - v| <= 1e-6·(1 + |v|) + 16·ulp`. Inclusive, with a
  small ULP allowance for text-to-double noise instead of decimal rounding.
  It agrees with all 36 `tolerance/` cases (conformance dashboard).
- **IDS 1.1 preview:** the #418 candidate exactly: bounds `v ∓ (|v|·ε + ε)`,
  each rounded half-to-even to 15 decimal places, compared inclusively
  (`packages/ids/src/preview/tolerance.ts`). It also agrees with all 36
  `tolerance/` cases and keeps every other corpus verdict
  (`src/preview/ids11-corpus.test.ts`), and reproduces the bound column of the
  table in `tolerance.md` (`src/preview/tolerance.test.ts`).

Two different implementations of the inclusive reading agree with the whole
corpus; the strict text agrees with neither.

## Proposed resolution

1. Change the formula in `tolerance.md` to `<=` and `>=` (both maintainers in
   #418 lean this way).
2. State how the bounds are computed: in decimal arithmetic, or in double
   arithmetic with each bound rounded to 15 decimal places, half to even.
   Without that sentence, two conforming implementations can disagree on a
   value one ULP from a bound.
3. Keep "the tolerance value is not configurable" and "tolerance does not
   apply to ranges" as they are.

## Proposed corpus cases

The table in `tolerance.md` has an asterisked row for magnitudes near 1e6,
where double precision starts to matter, and no test exercises it:

- `proposed-corpus-cases/tolerance/pass-comparison_tolerance_for_floating_point_million_upper_bound`
  (`v = 1000000`, `x = 1000001.000001`, the inclusive upper bound)
- `proposed-corpus-cases/tolerance/fail-comparison_tolerance_for_floating_point_million_upper_bound`
  (`x = 1000001.000002`)

ifc-lite gives both the named verdict in IDS 1.0 mode.
