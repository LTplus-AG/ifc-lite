# @ifc-lite/lens

Rule-based 3D filtering and colorization for IFC models. A framework-agnostic action engine: evaluate each rule's shared `FilterGroup[]` against your model, then apply visual actions (colorize, hide, make transparent) to the selected global IDs. `LensDataProvider` supplies entity iteration and auto-color data from any data store.

## Install

```bash
npm install @ifc-lite/lens
```

## Usage

```ts
import { evaluateLens, BUILTIN_LENSES } from '@ifc-lite/lens';
import type { LensDataProvider } from '@ifc-lite/lens';

// Bridge your data source (IfcDataStore, a server API, IndexedDB, ...)
// to the engine by implementing LensDataProvider.
declare const provider: LensDataProvider;
declare const selectedByRule: ReadonlyMap<string, ReadonlySet<number>>;

const result = evaluateLens(BUILTIN_LENSES[0], provider, selectedByRule);
// result.colorMap   - Map<globalId, RGBAColor>
// result.hiddenIds  - Set<globalId>
// result.ruleCounts - Map<ruleId, count>
```

## Features

The viewer stores manual rules as shared `FilterGroup[]` chips. Evaluate each
rule with `@ifc-lite/rules`, convert model-local IDs to global IDs, and pass
those ID sets by rule ID as the required third argument to `evaluateLens`.
Missing selections match nothing. The standalone v1 matcher has been removed.

- `evaluateLens` / `evaluateAutoColorLens`: turn a `Lens` definition into color and visibility maps
- Auto-color mode: assign distinct colors per IFC class, property value, or material automatically, with a generated legend
- `BUILTIN_LENSES` presets (for example "By IFC Class")
- `discoverClasses` / `discoverDataSources` to populate lens editors from model data
- Color helpers: `hexToRgba`, `rgbaToHex`, `uniqueColor`, `GHOST_COLOR`, `LENS_PALETTE`
- Fully typed: `Lens`, `LensRule`, `LensEvaluationResult`, `RGBAColor`

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
