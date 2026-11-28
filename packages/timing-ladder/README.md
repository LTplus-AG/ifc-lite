# @ifc-lite/timing-ladder

Private (unpublished) test helper. It guards a decision against superlinear
cost on hostile input: it feeds the decision a growing hostile string and
reports the first size at which one call costs at least a fixed CPU-time
budget. It is a timing check over a finite ladder, not a proof of linearity:
a superlinear implementation that stays under the budget on every rung passes.

It replaces two near-identical copies that used to live in the numeric-literal
tests of `@ifc-lite/encoding` and `@ifc-lite/ids` (#3224). Both packages now
take it as a devDependency.

```ts
import { firstBlownRung } from '@ifc-lite/timing-ladder';
import { expect, it } from 'vitest';

declare function isNumericLiteral(v: string): boolean;

it('rejects a long hostile literal in linear time', () => {
  // The trailing non-digit makes the scan read the whole string before it rejects.
  expect(firstBlownRung(isNumericLiteral, { hostile: (n) => '1'.repeat(n) + 'x' })).toBeNull();
});
```

- `firstBlownRung(decide, { hostile })` returns the first size in `SIZES`
  (20,000 doubling to 2,560,000 characters) whose call took at least
  `BUDGET_MS` (500 ms), or `null` when every rung cleared. Each rung takes
  the fastest of up to `ATTEMPTS` (3) readings.
- `decide` must reject every hostile fixture. If it accepts one, the ladder
  throws, because the reading would have timed an early return, not a full
  scan.
- Time is CPU time from `process.cpuUsage()`, not the wall clock, so a loaded
  CI runner does not fail the check. Without `process.cpuUsage()` it throws
  rather than falling back to the wall clock. The counter is process-wide:
  keep consuming packages on Vitest's default `forks` pool, because
  `pool: 'threads'` would charge sibling test files' CPU to the reading.
- `sizes`, `budgetMs` and `attempts` can be overridden for the package's own
  self-test; consumers should leave them alone.

The full reasoning, with measurements, is in the docblock of `src/index.ts`.
