# Bulk Query filter groups (#5898)

The browser witness loads the authored buildingSMART `building-architecture.ifc` sample. In the real Bulk Property Editor, it adds two Name filter groups: `plumbing wall` and `house - outer wall - house right front`. The UI reports four matches (each name occurs on an `IfcWall` and its `IfcWallType`) before Apply. The screenshot shows both groups and the count. The test then applies `Pset_BulkGroupWitness.Code = TWO_GROUPS` and reads the mutation view, asserting that exactly those four named entities changed.

Run after `pnpm build`:

```sh
PLAYWRIGHT_PORT=4411 pnpm exec playwright test tests/e2e/bulk-filter-groups.e2e.spec.ts --project=viewer-e2e-ci --workers=1
```

Result: 1/1 Chromium E2E passed on 2026-09-26 against the local production viewer build (61/61 root build tasks). The screenshot was captured before Apply so the two authored filter groups, four-match count, and chosen action are visible together.
