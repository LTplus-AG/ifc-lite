# Lenses

Lenses are rule-based 3D filters: they colorize, hide, or ghost entities based on what the model data says about them. The `@ifc-lite/lens` package evaluates a lens against model data and produces a color map you can apply to any renderer, plus counts and legends for UI.

## How It Works

A **lens** is a named set of rules. Each **rule** has:

- **Criteria** - A single condition on one axis (IFC class, property, material, attribute, quantity, classification, model, or group)
- **Action** - `colorize`, `hide`, or `transparent`
- **Color** - A hex color used by `colorize` and `transparent`

`evaluateLens` checks every entity against the enabled rules in order; the first matching rule wins. Entities that match no rule are **ghosted** (a faint neutral color) so the matches stand out.

Alternatively, a lens can use **auto-color**: instead of hand-written rules, it groups entities by the distinct values of one data source (IFC class, a property, a material, ...) and assigns each group a color automatically, producing a legend.

## Quick Start

```typescript
import { evaluateLens, BUILTIN_LENSES } from '@ifc-lite/lens';

// BUILTIN_LENSES includes a "Structural" preset:
// columns red, beams blue, slabs yellow, footings green
const structural = BUILTIN_LENSES.find((l) => l.id === 'lens-structural')!;

declare const selectedByRule: ReadonlyMap<string, ReadonlySet<number>>;
const result = evaluateLens(structural, provider, selectedByRule);

result.colorMap;      // Map<expressId (number), [r, g, b, a]> (0-1 range)
result.hiddenIds;     // Set<expressId (number)> from 'hide' rules
result.ruleCounts;    // Map<ruleId, matchCount>
result.executionTime; // ms
```

The `provider` is a `LensDataProvider`, an adapter interface over your parsed model data (entity types, property values, materials, and so on), so the package is renderer- and parser-agnostic.

## Built-in Lenses

`BUILTIN_LENSES` ships seven presets:

| Id | Name | What it does |
|----|------|--------------|
| `lens-by-class` | By IFC Class | Auto-colors every entity by its IFC class |
| `lens-structural` | Structural | Columns, beams, slabs, footings in distinct colors |
| `lens-envelope` | Building Envelope | Roofs, curtain walls, windows, doors, walls |
| `lens-openings` | Openings & Circulation | Doors, windows, stairs, ramps, railings |
| `lens-auto-material` | By Material | Auto-colors by material name |
| `lens-by-model` | By Model | Auto-colors by source model (federation) |
| `lens-by-zone` | By Zone | Auto-colors by IfcZone/IfcGroup membership |

## Rule Filters

The viewer Lens editor now authors `FilterGroup[]` chips using the same selector
as Search and Lists. Saved v1 `criteria` are converted when their meaning is
exactly representable; other saved conditions remain visible with a warning
until the user explicitly replaces them. For programmatic evaluation, pass a
map of rule IDs to selected global IDs as the required third argument to
`evaluateLens`. Missing rule IDs match nothing. The viewer keeps the saved v1
criteria shape private to its JSON migration path; the published Lens package
exposes only shared group based manual rules.

## Worked Example: Color by Fire Rating

Hand-authored groups, one rule per rating value you care about:

```typescript
import { evaluateLens, type Lens } from '@ifc-lite/lens';

const fireLens: Lens = {
  id: 'fire-rating',
  name: 'Fire Rating',
  rules: [
    {
      id: 'fr-90',
      name: 'REI 90',
      enabled: true,
      groups: [{
        combinator: 'AND',
        rules: [{
          kind: 'property', setName: 'Pset_WallCommon', setNameKind: 'literal',
          propertyName: 'FireRating', propertyNameKind: 'literal', op: 'eq', value: '90',
        }],
      }],
      action: 'colorize',
      color: '#E53935',
    },
    // ...more rules for other rating values
  ],
};

// Evaluate each rule's groups with @ifc-lite/rules, then map its rows to
// global IDs before applying the Lens actions.
declare const selectedByRule: ReadonlyMap<string, ReadonlySet<number>>;
const result = evaluateLens(fireLens, provider, selectedByRule);
```

Or let auto-color enumerate every distinct rating and build the palette and legend for you:

```typescript
import { evaluateAutoColorLens, type AutoColorSpec } from '@ifc-lite/lens';

const spec: AutoColorSpec = {
  source: 'property',
  psetName: 'Pset_WallCommon',
  propertyName: 'FireRating',
};

const result = evaluateAutoColorLens(spec, provider);

result.legend; // [{ label, color, count }, ...] one entry per distinct value
```

Auto-color groups entities by value in a single pass, sorts groups by size, assigns stable distinct colors, and ghosts entities without a value. `AutoColorSpec.source` accepts `ifcType`, `attribute`, `property`, `quantity`, `classification`, `material`, `model`, or `group`.

Property set and property names are matched as exact strings against whatever the model actually contains; use discovery (below) to find the real names first.

## Discovering What a Model Contains

To populate a lens editor UI:

```typescript
import { discoverClasses, discoverDataSources } from '@ifc-lite/lens';

const classes = discoverClasses(provider);
// sorted unique IFC class names present in the model

const sources = discoverDataSources(provider, { properties: true, materials: true });
// samples entities to list available psets, qsets, classification systems, materials
```

## Applying Results to the Renderer

`result.colorMap` is a `Map<number, [r, g, b, a]>` with components in the 0-1 range, which is exactly what `SceneContents.setColorOverrides` in `@ifc-lite/renderer` accepts:

```typescript
import { evaluateLens, BUILTIN_LENSES } from '@ifc-lite/lens';

declare const selectedByRule: ReadonlyMap<string, ReadonlySet<number>>;
const lensResult = evaluateLens(BUILTIN_LENSES[0], provider, selectedByRule);

// scene is a SceneContents, from renderer.getScene()
scene.setColorOverrides(lensResult.colorMap, device, pipeline);

// remove the lens
scene.clearColorOverrides();
```

Color overrides are shaded from a per-entity color table during opaque model draws, so the base model is never modified or copied. An eligible opaque mesh that streams in after the call is painted too; `hiddenIds` is applied separately through your visibility mechanism. Ghosted (unmatched) entries carry a shared ghost color you can detect with `isGhostColor` if you want to filter them out of legends.

This is exactly how the viewer wires it: the Lens panel evaluates the active lens, pushes `colorMap` into the store, and the geometry streaming hook calls `scene.setColorOverrides` on the next frame. See [Rendering](rendering.md) for the renderer setup.

## Key Exports

| Export | Description |
|--------|-------------|
| `evaluateLens(lens, provider, matchedByRule)` | Apply rule actions to shared evaluator global-ID sets; returns `LensEvaluationResult` |
| `evaluateAutoColorLens(spec, provider)` | Group-by-value colorization with legend |
| `discoverClasses(provider)` / `discoverDataSources(provider, categories)` | Populate editor UIs |
| `BUILTIN_LENSES` | The seven built-in presets |
| `hexToRgba` / `rgbaToHex` / `uniqueColor` / `isGhostColor` / `GHOST_COLOR` | Color helpers |

Key types: `Lens`, `LensRule`, `AutoColorSpec`, `LensEvaluationResult`, `LensDataProvider`, `RGBAColor`.
