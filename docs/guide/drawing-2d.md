# 2D Architectural Drawings

IFClite can generate 2D architectural drawings from 3D IFC models, including section cuts, floor plans, and elevations. The `@ifc-lite/drawing-2d` package produces vector SVG output with proper architectural conventions.

## What It Generates

From any 3D IFC model, you can produce:

- **Floor plans** - Horizontal section cuts at a specified height
- **Section cuts** - Vertical sections through the model
- **Elevations** - A vertical section placed just outside the building, with projection lines enabled, reads as an elevation (there is no separate elevation API)

Each drawing includes:

| Element | Description |
|---------|-------------|
| **Cut lines** | Bold lines where geometry intersects the section plane |
| **Projection lines** | Visible geometry beyond the cut plane |
| **Hidden lines** | Occluded geometry rendered as dashed lines |
| **Hatching** | Material-based fill patterns (concrete, masonry, insulation, etc.) |
| **Architectural symbols** | Door swings, window frames, stair arrows |
| **Annotations** | Dimensions and labels |

## Quick Start

### Generating a Floor Plan

```typescript
import { generateFloorPlan } from '@ifc-lite/drawing-2d';

// generateFloorPlan(meshes: MeshData[], elevation: number, options?)
const drawing = await generateFloorPlan(meshData, 1.2, {
  includeHiddenLines: true,
  includeProjection: true,
});

console.log(`${drawing.stats.cutLineCount} cut lines`);
console.log(`${drawing.stats.projectionLineCount} projection lines`);
```

### Generating a Section

```typescript
import { generateSection, createSectionConfig } from '@ifc-lite/drawing-2d';

// createSectionConfig(axis, position, options?)
const config = createSectionConfig('z', 5.0);

// generateSection(meshes: MeshData[], axis: 'x' | 'z', position: number, options?)
const drawing = await generateSection(meshData, 'z', 5.0);
```

### SVG Export

```typescript
import { exportToSVG } from '@ifc-lite/drawing-2d';

const svg = exportToSVG(drawing, {
  showHatching: true,
  showHiddenLines: true,
  scale: { name: '1:100', factor: 100, useCase: 'Floor plans' },
  title: 'Ground Floor Plan',
});

// svg is a string of SVG markup
document.getElementById('drawing').innerHTML = svg;
```

## Drawing Sheets

For presentation-ready output, drawings can be placed on sheets with frames and title blocks:

```typescript
import {
  createFrame,
  createTitleBlock,
  renderFrame,
  renderTitleBlock,
  renderScaleBar,
  DEFAULT_SCALE_BAR,
  PAPER_SIZE_REGISTRY,
} from '@ifc-lite/drawing-2d';

// Create an A1 landscape sheet. PAPER_SIZE_REGISTRY is keyed by id.
const paper = PAPER_SIZE_REGISTRY.A1_LANDSCAPE;

// createFrame takes a FrameStyle string:
//   'simple' | 'professional' | 'minimal' | 'iso' | 'custom'
const frame = createFrame('professional');

// createTitleBlock takes a TitleBlockLayout string:
//   'compact' | 'standard' | 'extended' | 'custom'
// (title text/fields are populated via updateTitleBlockField)
const titleBlock = createTitleBlock('standard');

// Renderers return result objects, not raw SVG strings.
const frameResult = renderFrame(paper, frame);
const titleBlockResult = renderTitleBlock(titleBlock, frameResult.innerBounds);
const scale = { name: '1:100', factor: 100, useCase: 'Floor plans' };
const scaleBarSvg = renderScaleBar(DEFAULT_SCALE_BAR, scale, { x: 20, y: 20 });

const frameSvg = frameResult.svgElements;
const titleBlockSvg = titleBlockResult.svgElements;
```

## Graphic Overrides

Control how elements appear in 2D drawings using graphic override presets:

```typescript
import { createOverrideEngine, ARCHITECTURAL_PRESET } from '@ifc-lite/drawing-2d';

const engine = createOverrideEngine();

// Apply a built-in preset
engine.setRules(ARCHITECTURAL_PRESET.rules);
// Available: VIEW_3D_PRESET, ARCHITECTURAL_PRESET, FIRE_SAFETY_PRESET,
//           STRUCTURAL_PRESET, MEP_PRESET, MONOCHROME_PRESET

// Or add custom rules
engine.addRule({
  id: 'highlight-walls',
  name: 'Highlight Load-Bearing Walls',
  enabled: true,
  priority: 1,
  criteria: { type: 'ifcType', ifcTypes: ['IFCWALL'] },
  style: { lineWeight: 0.5, strokeColor: '#FF0000' },
});
```

## Architectural Symbols

The package generates proper architectural symbols:

| Symbol | Description |
|--------|-------------|
| **Door swings** | Arc showing door opening direction and angle |
| **Sliding doors** | Arrow showing sliding direction |
| **Window frames** | Double-line representation with glass |
| **Stair arrows** | Direction arrows with UP/DOWN labels |

```typescript
import { generateDoorSymbol, generateWindowSymbol } from '@ifc-lite/drawing-2d';

// `opening` is an OpeningInfo (extracted from the model), `bounds2D` its
// projected footprint (Bounds2D), and `wallDirection` the wall's in-plane
// axis as a Point2D.
// generateDoorSymbol(opening, bounds2D, wallDirection): DoorSymbolResult
const doorResult = generateDoorSymbol(opening, bounds2D, wallDirection);

// generateWindowSymbol(opening, bounds2D, wallDirection, wallThickness?): WindowSymbolResult
const windowResult = generateWindowSymbol(opening, bounds2D, wallDirection, 0.3);

// Both return result objects (not SVG strings):
//   doorResult.lines / doorResult.arcPath, windowResult.lines

```

## GPU Acceleration

For large models, section cutting can be GPU-accelerated:

```typescript
import { GPUSectionCutter, isGPUComputeAvailable } from '@ifc-lite/drawing-2d';

// isGPUComputeAvailable() is synchronous - do not await it.
if (isGPUComputeAvailable()) {
  const cutter = new GPUSectionCutter(gpuDevice);
  // Allocate GPU buffers first; cutMeshes throws if initialize() was not called.
  await cutter.initialize(maxTriangles);
  const result = await cutter.cutMeshes(meshData, sectionConfig);
}
```

## Viewer Integration

In the IFClite viewer:

1. **Activate section plane** - Position a section plane in the 3D view
2. **Open 2D panel** - The 2D drawing panel shows the section cut
3. **Toggle layers** - Show/hide cut lines, projection, hidden lines, hatching
4. **Annotate** - Add measurements, polygon areas, text boxes, and revision clouds
5. **Select & edit** - Click annotations to select, drag to move, Delete to remove
6. **Graphic overrides** - Apply presets to change element appearance
7. **Export SVG** - Download the drawing as vector SVG

### Annotation Tools

| Tool | Description | Shortcuts |
|------|-------------|-----------|
| **Distance Measure** | Click two points to measure distance | Shift = lock axis |
| **Area Measure** | Click polygon vertices, close near first point or double-click | Shift = orthogonal |
| **Text Box** | Click to place, type text, Enter to confirm | Double-click to re-edit |
| **Revision Cloud** | Click two corners to define rectangle | Shift = square |
| **Select / Pan** | Click annotations to select, drag to move | Escape = exit tool / deselect |

### Annotation Selection

When using the Select / Pan tool (or after pressing Escape to exit a creation tool):

- **Click** any annotation to select it (blue dashed border with corner handles)
- **Drag** the selected annotation to reposition it
- **Delete** or **Backspace** to remove the selected annotation
- **Double-click** a text annotation to re-enter edit mode
- **Escape** to deselect or exit annotation tools

### Display Options

| Option | Default | Description |
|--------|---------|-------------|
| Hidden lines | On | Show occluded geometry as dashed lines |
| Hatching | On | Material-based fill patterns |
| Annotations | On | Dimensions and labels |
| 3D overlay | On | Show section plane position in 3D view |
| Scale | 1:100 | Drawing scale for dimensions |
| Symbolic representations | Off | Use authored Plan/Annotation representations when available |
