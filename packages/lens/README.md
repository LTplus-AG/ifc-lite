# @ifc-lite/lens

Rule-based 3D filtering and colorization for IFC models. A pure, framework-agnostic evaluation engine: you define lenses whose rules match entities by IFC class, property value, material, or classification, and apply visual actions (colorize, hide, make transparent). The engine has zero dependencies and reads model data through a small `LensDataProvider` interface, so it works with any data store.

## Install

```bash
npm install @ifc-lite/lens
```

## Usage

```ts
import { evaluateLens, BUILTIN_LENSES } from '@ifc-lite/lens';
import type { LensDataProvider } from '@ifc-lite/lens';

const provider: LensDataProvider = createMyProvider(myData);
const result = evaluateLens(BUILTIN_LENSES[0], provider);
// result.colorMap   - Map<globalId, RGBAColor>
// result.hiddenIds  - Set<globalId>
// result.ruleCounts - Map<ruleId, count>
```

## Features

- `evaluateLens` / `evaluateAutoColorLens`: turn a `Lens` definition into color and visibility maps
- Auto-color mode: assign distinct colors per IFC class, property value, or material automatically, with a generated legend
- `matchesCriteria` for standalone rule matching
- `BUILTIN_LENSES` presets (for example "By IFC Class")
- `discoverClasses` / `discoverDataSources` to populate lens editors from model data
- Color helpers: `hexToRgba`, `rgbaToHex`, `uniqueColor`, `GHOST_COLOR`, `LENS_PALETTE`
- Fully typed: `Lens`, `LensRule`, `LensCriteria`, `LensEvaluationResult`, `RGBAColor`

## Links

- Docs: https://ifclite.dev/docs/
- Source: https://github.com/LTplus-AG/ifc-lite

## License

MPL-2.0
