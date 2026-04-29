# @ifc-lite/drawing-2d

2D architectural drawings from 3D IFC models. Generates floor plans, sections, and elevations as vector SVG with cut lines, projection lines, hidden lines, material hatching, and architectural symbols (door swings, stair arrows, window frames). Optionally GPU-accelerated.

## Installation

```bash
npm install @ifc-lite/drawing-2d
```

## Floor plan

```typescript
import { generateFloorPlan, exportToSVG } from '@ifc-lite/drawing-2d';

// Cut at 1.2m above floor level (standard architectural plan height)
const drawing = await generateFloorPlan(meshes, 1.2, {
  includeHiddenLines: true,
  includeMaterialHatching: true,
});

const svg = exportToSVG(drawing, {
  showHatching: true,
  scale: 1 / 50, // 1:50
  paperSize: 'A3',
});

// Render in the browser
document.body.innerHTML = svg;
```

## Section cut

```typescript
import { generateSection } from '@ifc-lite/drawing-2d';

// Vertical section through plane y = 5 (looking +Y)
const section = await generateSection(meshes, {
  plane: { axis: 'y', position: 5, normal: [0, 1, 0] },
  depth: 20,                     // how far behind the cut to render
  includeHiddenLines: false,
  includeProjectionLines: true,
});

const svg = exportToSVG(section);
```

Supported plane axes: `'x'` (transverse section), `'y'` (longitudinal), `'z'` (horizontal — useful for ceiling plans). For arbitrary cut directions pass an explicit `normal` plus `position`.

## Elevation

```typescript
import { generateElevation } from '@ifc-lite/drawing-2d';

const elevation = await generateElevation(meshes, {
  direction: 'north',  // 'north' | 'south' | 'east' | 'west'
  showShadows: false,
});

document.body.innerHTML = exportToSVG(elevation);
```

## Drawing sheets

Compose multiple drawings on a single sheet with frame, title block, and scale bar:

```typescript
import { createSheet, exportSheetToSVG } from '@ifc-lite/drawing-2d';

const sheet = createSheet({
  paperSize: 'A1',
  orientation: 'landscape',
  titleBlock: {
    project: 'Office Tower',
    drawing: 'Ground Floor Plan',
    scale: '1:100',
    revision: 'A',
    drawn: 'LT',
    date: '2026-04-29',
  },
  drawings: [
    { drawing: floorPlan, position: { x: 50, y: 50 }, scale: 1 / 100 },
    { drawing: section, position: { x: 50, y: 400 }, scale: 1 / 100 },
  ],
});

const svg = exportSheetToSVG(sheet);
```

## Graphic override presets

```typescript
import { applyGraphicPreset } from '@ifc-lite/drawing-2d';

applyGraphicPreset(drawing, 'fire-safety');
//   - Highlights egress paths
//   - Tints fire-rated walls red
//   - Colours fire-protection equipment

// Other presets: 'architectural' (default), 'structural', 'mep', 'fire-safety'
```

## API

See the [2D Drawings Guide](../../docs/guide/drawing-2d.md) and [API Reference](../../docs/api/typescript.md#ifc-litedrawing-2d).

## License

[MPL-2.0](../../LICENSE)
