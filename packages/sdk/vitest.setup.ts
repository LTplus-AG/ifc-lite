/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Warm the namespace packages that the SDK loads lazily, once per worker,
 * before any test's timer starts.
 *
 * Every namespace here resolves its implementation with a dynamic `import()`
 * on first use (`loadIds`, `loadLists`, `loadDrawing`, `loadBcf`,
 * `loadSandbox`) so consumers who never touch `bim.ids` or `bim.list` do not
 * pay for them. That is the right tradeoff for real callers and a trap for
 * tests: whichever test happens to run first pays the whole cold-import cost
 * inside its own 5000ms budget. Measured for `@ifc-lite/lists` plus
 * `@ifc-lite/data`: 2002ms cold, 481ms on a warm repo, 2-3ms once resolved.
 *
 * Under CI's parallel load that alone crosses the default. It has now been
 * fixed three times, once per namespace, each time by warming that one file:
 * `ids.test.ts` (3a00b5e64, reporting 5021-5038ms), `list.test.ts` (#2935,
 * five unrelated PRs failing at once between 5005ms and 5056ms), and
 * `packages/export/src/parquet-geometry.test.ts` (#2248) for the same shape
 * elsewhere. `drawing`, `bcf` and `sandbox` share the idiom and had not fired
 * yet. This replaces the per-file patches with one mechanism so the fourth
 * instance does not happen.
 *
 * Chosen over raising `testTimeout`, which is how `packages/data` handles its
 * own cold-transform cost: a blanket raise buys the same green at the price of
 * every genuine hang in this package taking the new timeout to report. Warming
 * moves the cost outside the budget instead, so the tight 5000ms default keeps
 * doing its job.
 *
 * The price, stated because it is not free: every test file now pays this,
 * including the ten that touch none of these packages. Measured --
 * `src/types.test.ts` goes 76ms -> 680ms, and the full suite at
 * `--maxWorkers=2` (closer to a CI runner than a 12-core laptop) goes 1.61s ->
 * 2.26s. Sub-second at CI-like concurrency, against a failure mode that took
 * main red for an hour, so the trade is worth making -- but it is a trade.
 *
 * `allSettled`, not `all`: `@ifc-lite/sandbox` is deliberately NOT a dependency
 * of the SDK and never can be -- it depends on `@ifc-lite/sdk`, so adding it
 * would be a cycle. Its import therefore rejects here permanently, exactly as
 * it does for a consumer who has not installed it. It stays in the list so the
 * drift test below keeps covering `sandbox.ts`, and so nobody "fixes" the
 * omission later; it is inert by construction, not by accident. More generally,
 * a namespace that cannot be warmed must not take the suite down -- the warm-up
 * is an optimisation, and every test still passes without it, just closer to
 * the timeout.
 */
const LAZY_NAMESPACE_PACKAGES = [
  '@ifc-lite/ids',
  '@ifc-lite/lists',
  '@ifc-lite/data',
  '@ifc-lite/drawing-2d',
  '@ifc-lite/bcf',
  '@ifc-lite/sandbox',
];

await Promise.allSettled(
  LAZY_NAMESPACE_PACKAGES.map((name) => import(/* @vite-ignore */ name)),
);
