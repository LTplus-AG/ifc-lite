# Lenses

Lenses color, hide, or ghost IFC entities according to saved filter groups. The viewer uses the same `FilterGroup[]` query model as Search, Lists, and Bulk editing. Rules run in order: the first matching rule owns each entity's appearance. Unmatched entities receive a faint ghost color.

A lens may instead use **auto-color** to group entities by a data source, such as IFC class, material, property, classification, model, or zone. Auto-color assigns each distinct value a color and produces a legend.

## Built-in lenses

`BUILTIN_LENSES` ships seven presets:

| Id | Name | What it does |
|----|------|--------------|
| `lens-by-class` | By IFC Class | Auto-colors every entity by IFC class |
| `lens-structural` | Structural | Colors columns, beams, slabs, and footings |
| `lens-envelope` | Building Envelope | Colors roofs, curtain walls, windows, doors, and walls |
| `lens-openings` | Openings & Circulation | Colors doors, windows, stairs, ramps, and railings |
| `lens-auto-material` | By Material | Auto-colors by material name |
| `lens-by-model` | By Model | Auto-colors by source model |
| `lens-by-zone` | By Zone | Auto-colors by IfcZone or IfcGroup membership |

## Manual rules

Each `LensRule` has `groups: FilterGroup[]`, an action (`colorize`, `hide`, or `transparent`), and a hex color for the color actions. Groups are ORed together. Within a group, its `combinator` controls whether all or any rules match. The Lens panel embeds the shared Filter Group editor, including the same property, attribute, quantity, class, GlobalId, and model chips used in other query surfaces.

For a single model, evaluate the groups with `@ifc-lite/rules`, then pass each rule's selected IDs to `evaluateLens`. The package handles action priority, ghost colors, hide sets, and legend counts. The viewer's `useLens` hook uses the federated group evaluator and translates model-local IDs to global IDs before this final step.

```typescript
import { evaluateLens, type Lens, type LensDataProvider } from '@ifc-lite/lens';
import { evaluateFilterGroups } from '@ifc-lite/rules';
import type { IfcDataStore } from '@ifc-lite/parser';

function evaluateSingleModelLens(lens: Lens, provider: LensDataProvider, store: IfcDataStore) {
  const selected = new Map(lens.rules.map((rule) => [
    rule.id,
    new Set(evaluateFilterGroups('primary', store, rule.groups, {
      limit: Number.MAX_SAFE_INTEGER,
    }).map((row) => row.expressId)),
  ] as const));
  return evaluateLens(lens, provider, selected);
}
```

`LensDataProvider` enumerates the entities and supplies data for auto-color, rule actions, and legend counts. In a single-model viewer, global IDs equal EXPRESS IDs. Federated applications must translate each result's `(modelId, expressId)` through their global-ID registry.

For example, a fire-rating lens rule can use an AND group containing an IFC class rule and a property comparison:

```typescript
import type { Lens } from '@ifc-lite/lens';

const fireLens: Lens = {
  id: 'fire-rating',
  name: 'Fire Rating',
  rules: [{
    id: 'fr-90', name: 'REI 90', enabled: true,
    groups: [{ combinator: 'AND', rules: [
      { kind: 'ifcType', op: 'in', values: ['IfcWall'] },
      { kind: 'property', setName: 'Pset_WallCommon', propertyName: 'FireRating', op: 'eq', value: '90' },
    ] }],
    action: 'colorize', color: '#E53935',
  }],
};
```

## Auto-color

```typescript
import { evaluateAutoColorLens, type AutoColorSpec, type LensDataProvider } from '@ifc-lite/lens';

function colorByRating(provider: LensDataProvider) {
  const spec: AutoColorSpec = {
    source: 'property', psetName: 'Pset_WallCommon', propertyName: 'FireRating',
  };
  return evaluateAutoColorLens(spec, provider);
}
```

`AutoColorSpec.source` accepts `ifcType`, `attribute`, `property`, `quantity`, `classification`, `material`, `model`, or `group`. Values absent from the selected source are ghosted by default. Use `discoverClasses` and `discoverDataSources` from `@ifc-lite/lens` to populate data-source choices from a loaded model.

## Saved v1 lenses

Local storage and `lenses.json` imports using `LensCriteria` are migrated when loaded. Small nested AND/OR trees are normalized to equivalent Filter Groups. Conditions with no exact mapping remain in the saved rule as unreadable legacy data: they match nothing, show a warning in the editor, and survive export and re-import until the user explicitly replaces them. An unreadable condition is never guessed into a different query.

## Applying the result

`evaluateLens` returns a `colorMap` of global IDs to normalized RGBA tuples, `hiddenIds`, per-rule counts and ID lists, and evaluation time. `SceneContents.setColorOverrides` in `@ifc-lite/renderer` accepts the color map. The viewer renders it as an overlay over original geometry and synchronizes `hiddenIds` through the visibility owner. Clearing the lens removes the overlay without changing model geometry. See [Rendering](rendering.md).

## Main exports

| Export | Use |
|--------|-----|
| `evaluateLens(lens, provider, selectedByRule)` | Apply ordered manual rule actions to selected global IDs |
| `evaluateAutoColorLens(spec, provider)` | Color by distinct values and return legend entries |
| `discoverClasses` / `discoverDataSources` | Populate editor choices from model data |
| `BUILTIN_LENSES` | Seven presets |
| `hexToRgba` / `rgbaToHex` / `uniqueColor` / `isGhostColor` / `GHOST_COLOR` | Color helpers |

Key types: `Lens`, `LensRule`, `AutoColorSpec`, `LensEvaluationResult`, `LensDataProvider`, `RGBAColor`.
