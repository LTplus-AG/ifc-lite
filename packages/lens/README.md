# @ifc-lite/lens

Color and visibility actions for IFC models. Manual `LensRule` entries select entities with `FilterGroup[]` from `@ifc-lite/rules`; the Lens engine applies the first matching rule to each entity, ghosts unmatched entities, and returns colors, hidden IDs, and legend counts. Auto-color lenses group by IFC data source.

## Install

```bash
npm install @ifc-lite/lens @ifc-lite/rules
```

## Usage

```ts
import { evaluateLens, type Lens, type LensDataProvider } from '@ifc-lite/lens';

function applySelectedRules(
  lens: Lens,
  provider: LensDataProvider,
  selectedByRule: ReadonlyMap<string, ReadonlySet<number>>,
) {
  const result = evaluateLens(lens, provider, selectedByRule);
  // result.colorMap   - Map<globalId, RGBAColor>
  // result.hiddenIds  - Set<globalId>
  // result.ruleCounts - Map<ruleId, count>
  return result;
}
```

Use `evaluateFilterGroups` or `evaluateFilterGroupsFederated` from `@ifc-lite/rules` to fill `selectedByRule`. For federated models, translate each `(modelId, expressId)` to the application's global ID before passing the sets to `evaluateLens`. The viewer does this in `useLens`.

`evaluateAutoColorLens` works directly with a `LensDataProvider` and assigns distinct colors per IFC class, property value, material, classification, model, or group. `BUILTIN_LENSES` supplies seven presets, and `discoverClasses` / `discoverDataSources` populates editor choices from model data.

Saved v1 `LensCriteria` are migrated by the viewer at load/import time. Unrepresentable conditions remain inert, visible with a warning, and round-trip until replaced by the user.

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
