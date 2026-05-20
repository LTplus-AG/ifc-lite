# @ifc-lite/drawing-2d

2D architectural drawings from 3D IFC models. Generates floor plans and sections as vector SVG with cut lines, projection lines, hidden lines, material hatching, and architectural symbols (door swings, stair arrows, window frames). Optionally GPU-accelerated.

## Installation

```bash
npm install @ifc-lite/drawing-2d
```

## Floor plan

```typescript
import { generateFloorPlan, exportToSVG, PAPER_SIZES, COMMON_SCALES } from '@ifc-lite/drawing-2d';

// Cut at 1.2 m above floor level (standard architectural plan height)
const drawing = await generateFloorPlan(meshes, 1.2, {
  includeHiddenLines: true,
  includeMaterialHatching: true,
});

const svg = exportToSVG(drawing, {
  paperSize: PAPER_SIZES.A3_LANDSCAPE,
  scale: COMMON_SCALES.find((s) => s.factor === 50), // 1:50
  showHatching: true,
  showHiddenLines: true,
});

document.body.innerHTML = svg;
```

## Section cut

`generateSection` cuts vertically along the X or Z axis (use `generateFloorPlan` for horizontal cuts).

```typescript
import { generateSection, exportToSVG } from '@ifc-lite/drawing-2d';

// Vertical section through plane x = 5
const drawing = await generateSection(meshes, 'x', 5, {
  includeHiddenLines: false,
  includeProjectionLines: true,
});

const svg = exportToSVG(drawing);
```

For arbitrary sections (custom plane, projection depth, scale), use `Drawing2DGenerator` + `createSectionConfig` directly:

```typescript
import { Drawing2DGenerator, createSectionConfig } from '@ifc-lite/drawing-2d';

const generator = new Drawing2DGenerator();
await generator.initialize();

const config = createSectionConfig('y', 2.5, { projectionDepth: 5, scale: 50 });
const drawing = await generator.generate(meshes, config, {
  includeHiddenLines: true,
  includeMaterialHatching: true,
});

generator.dispose();
```

## Graphic overrides

Apply named graphic presets (architectural, fire-safety, structural, MEP, monochrome) via the override engine:

```typescript
import {
  createOverrideEngine,
  getBuiltInPreset,
  ifcTypeCriterion,
} from '@ifc-lite/drawing-2d';

// Use a built-in preset
const fireSafety = getBuiltInPreset('fire-safety');
const engine = createOverrideEngine(fireSafety?.rules);

// Or define custom rules
const custom = createOverrideEngine([
  {
    id: 'highlight-walls',
    name: 'Highlight load-bearing walls',
    enabled: true,
    priority: 10,
    criteria: ifcTypeCriterion(['IfcWall', 'IfcWallStandardCase']),
    style: { strokeColor: '#d62828', strokeWidth: 0.7 },
  },
]);

// Resolve the style for an element
const result = engine.applyOverrides({
  expressId: 12345,
  ifcType: 'IfcWall',
  properties: { /* psets keyed by name */ },
});
console.log(result.style);
```

Built-in presets: `architectural` (default), `structural`, `mep`, `fire-safety`, `monochrome`. List them via `BUILT_IN_PRESETS` or look one up with `getBuiltInPreset(id)`.

## Drawing sheets

For presentation output, the package ships paper sizes, drawing frames, title blocks, scale bars, and north arrows as composable building blocks rather than a single one-shot helper. Bring in the pieces you need from the `sheet` module:

```typescript
import {
  // Paper
  PAPER_SIZE_REGISTRY,
  getDefaultPaperSize,
  // Frames
  createFrame,
  renderFrame,           // returns { svgElements, innerBounds }
  // Title blocks
  createTitleBlock,
  renderTitleBlock,      // returns { svgElements, ... }
  DEFAULT_TITLE_BLOCK_FIELDS,
  // Scale bar / north arrow
  DEFAULT_SCALE_BAR,
  DEFAULT_NORTH_ARROW,
  renderScaleBar,
  renderNorthArrow,
} from '@ifc-lite/drawing-2d';
```

Each renderer returns SVG fragments that you wrap in your own `<svg>` document — see the [2D Drawings Guide](https://ltplus-ag.github.io/ifc-lite/guide/drawing-2d/) for a worked sheet-composition example.

## API

See the [2D Drawings Guide](https://ltplus-ag.github.io/ifc-lite/guide/drawing-2d/) and [API Reference](https://ltplus-ag.github.io/ifc-lite/api/typescript/#ifc-litedrawing-2d).

## License

[MPL-2.0](../../LICENSE)
