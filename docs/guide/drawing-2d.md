# 2D Architectural Drawings

IFClite can generate 2D architectural drawings from 3D IFC models, including section cuts, floor plans, and elevations. The `@ifc-lite/drawing-2d` package produces vector SVG output with proper architectural conventions.

Direct annotation fills with a matching 3D mesh render once in the viewer's
registered plane. Their symbolic fill data remains available to 2D drawings;
the 3D overlay routing does not delete or flatten the authored geometry.

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

## Drawings After Repositioning

In the viewer, section cuts and construction projection use the model's current
workspace placement. After [repositioning a model](federation.md#repositioning-models-and-pointclouds),
the floor and ceiling limits used for construction projection refresh with its
displayed geometry and storey membership.

To compare the same floor plan before and after a vertical move, move the
section plane by the same amount, or use the same section percentage for the
same model bounds. Once drawing generation finishes, the equivalent cut keeps
the same projection geometry and floor/ceiling bands. Moving only the model
while keeping an absolute section elevation fixed produces a different cut.

This is a viewer workspace adjustment: it does not rewrite the source IFC
placements. Existing measurements retain their recorded workspace points and
are marked stale after movement; remeasure them in the new arrangement.

## Projection Depth

Enable **Projection** to show geometry beyond the section cut, then open its
settings button. **Auto** uses the existing model and floor/ceiling bands.
Turn Auto off to enter a finite background depth in the selected display length
unit. The setting is stored in metres and remembered with the drawing options.
Zero removes background projection while keeping the cut; Down plan views retain
their separate overhead band. Flipping the section reverses the viewed side, and
depth is still measured behind the cut. Negative or non-finite
input does not replace the last valid setting.

Manual depth clips triangles and edges at the depth boundary before creating
projected outlines. Hidden-line occluders use the same clipped band, so geometry
outside the selected range cannot hide geometry inside it. Cardinal Down, Front
and Side sections support this control; arbitrary-plane placement has no manual
projection-depth control in this viewer workflow.

For SDK callers, set `SectionConfig.clipProjectionBands` to `true` alongside
`projectionBelowDepth` and `projectionAboveDepth` to request this bounded
projection behavior. Omitting the flag preserves the existing outline behavior.
For bounded projections, `includeHiddenLines: false` excludes occluded lines
behind the section while keeping dashed overhead outlines.

## Saved Sheet Setup

The viewer remembers each model's sheet setup in this browser: paper size,
frame, title-block fields and logo, revisions, drawing scale, scale bar, and
north arrow. Reopening the same file restores its setup; switching between
loaded models switches their sheets. File identity uses the complete file
contents, so a renamed copy shares its saved setup and changed contents start
with a separate setup.

Saved sheet templates form a reusable library across models. Clearing the
current sheet does not remove templates. Panel visibility and the sheet-enable
toggle are not restored after a browser reload.

The browser keeps the 20 most recently saved model setups; templates are not
part of that limit. This is local browser storage, not a backup or an IFC file
edit. Clearing site data removes it. Large embedded logos can exhaust browser
storage: a failed save logs a warning and retains the previous saved version.
Models without source bytes remain usable but cannot restore a sheet by file
content.

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

### DXF Export

Drawings can also be exported as ASCII DXF R12 (`AC1009`) — the universal
CAD interop baseline. Coordinates are written verbatim in the drawing's own
unit (metres); an optional `coordinateTransform` maps every point (drawing
geometry and underlays alike) right before it reaches the writer, which is
how the viewer georeferences plan sections to true world/map coordinates
(issue #1861):

```typescript
import { exportToDXF } from '@ifc-lite/drawing-2d';

const dxf = exportToDXF(drawing, {
  showHiddenLines: true,
  showHatching: true, // cut polygons become closed POLYLINE boundaries
  // Optional: applied to every emitted point, e.g. drawing -> world/CRS.
  coordinateTransform: (p) => ({ x: p.x + 2600000, y: 2007 - p.y }),
  // R12 has no $INSUNITS; the unit (and CRS, if any) goes in a leading 999 comment.
  metadataComment: 'ifc-lite section export - units: metres, CRS: EPSG:2056',
  // Optional: extra polylines on their own layers, mapped like everything else.
  polylineLayers: [{ name: 'SCAN-OUTLINE', color: '#0d9488', polylines: [[{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }]] }],
});
// dxf is the full ASCII DXF document text
```

Lines land on per-category layers (`IFC-CUT`, `IFC-PROJECTION`,
`IFC-HIDDEN`, …), hidden lines use a `DASHED` linetype, and colours are
resolved to the nearest AutoCAD Color Index. Layer names follow the strict
R12 symbol rules (31 chars, `A-Z a-z 0-9 $ - _`); names that collide after
sanitizing get a numeric suffix instead of merging.

The returned string declares `$DWGCODEPAGE ANSI_1252` in its HEADER — DXF
has no UTF-8 support before R2007 (AC1021). Encode it with
`encodeDxfCp1252` before writing it to a file or `Blob`; a plain UTF-8
encoder mismatches that declared codepage, and any real DXF reader
(AutoCAD, `ezdxf`, ...) then decodes non-ASCII text as mojibake:

```typescript
import { exportToDXF, encodeDxfCp1252 } from '@ifc-lite/drawing-2d';

declare const dxf: ReturnType<typeof exportToDXF>;
const { bytes, hadUnmappable } = encodeDxfCp1252(dxf);
// bytes is a Uint8Array ready to write to disk or a Blob.
// hadUnmappable is true if a character outside windows-1252 (e.g. CJK)
// was replaced with '?' — R12 TEXT has no wider single-byte encoding.
```

## Drawing Sheets

For presentation-ready output, drawings can be placed on sheets with frames and title blocks:

```typescript
import {
  createFrame,
  createTitleBlock,
  renderFrame,
  renderTitleBlock,
  DEFAULT_SCALE_BAR,
  DEFAULT_NORTH_ARROW,
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

// The scale bar and north arrow are drawn inside the title block; pass them
// as the fourth `extras` argument rather than rendering them separately.
const scale = { name: '1:100', factor: 100, useCase: 'Floor plans' };
const titleBlockResult = renderTitleBlock(titleBlock, frameResult.innerBounds, [], {
  scaleBar: DEFAULT_SCALE_BAR,
  northArrow: DEFAULT_NORTH_ARROW,
  scale,
});

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
2. **Open the Drawing panel** - The section cut appears in the **Drawing** panel, docked in the bottom strip below the 3D view (it opens with the Section tool, or from **Analyze → Drawing**, the sidebar rail or the command palette). Like the other bottom panels it can be resized, floated, or popped out onto another screen
3. **Toggle layers** - Show/hide cut lines, projection, hidden lines, hatching
4. **Annotate** - Add measurements, polygon areas, text boxes, and revision clouds
5. **Select & edit** - Click annotations to select, drag to move, Delete to remove
6. **Graphic overrides** - Apply presets to change element appearance
7. **Export** - Download the drawing as vector SVG, or as DXF R12 (plan sections are georeferenced to true world/map coordinates when the model carries an `IfcMapConversion`)

### Drawing Navigation

Wheel zoom follows the pointer and uses the input magnitude, including pixel,
line and page wheel deltas. Hold Ctrl or Cmd for fine zoom. A trackpad pinch
zooms normally unless that modifier key is physically held.

The navigation preset also applies to the Drawing panel: Default uses vertical
wheel movement to zoom and horizontal movement to pan; Navisworks uses vertical
wheel movement to zoom; Trackpad pans with two-finger scrolling and zooms with a
pinch or Ctrl/Cmd wheel. These controls also work in floating and popped-out
Drawing panels.

### DXF and PDF/Image Underlays

Open **Underlays → Import DXF...** to import DXF. Choose **Site plan (horizontal)** for CAD coordinates in IFC
XY or map coordinates, or **Reference on current section** for a plan/elevation registered
on the current Down, Front or Side plane. Vertical sections initially suggest
**Reference on current section**. The suggestion follows section changes until you
choose a mode explicitly; your choice then remains selected. Dropping a DXF onto
the viewport or opening it through the general file picker imports a site plan,
so use the Underlays picker for elevation references.

Choose explicit units when the file has no declared units;
automatic import uses a known DXF unit header. Drawing references with missing
or unknown unit declarations request an explicit unit before registration; site
plans retain the existing unitless-file heuristic. Unit conversion runs once,
independently of placement scale.

For site plans, **Align to model georeference** maps survey/map coordinates into
the model's local frame. Its automatic setting follows the anchor model's usable
georeference; clicking pins the setting. Turn it off for CAD already drawn in
local model coordinates, and on for map-coordinate surveys. The unitless
millimetre-inference path leaves alignment off; check coordinates as well as units.

A drawing reference freezes its IFC world origin and two in-plane axes when
import starts. Moving a parallel section does not move the reference; flipping
the view projects the same placement from the other side. An incompatible view
shows the reference as edge-on, and a changed engineering frame marks it
unavailable. Renderer origin rebasing preserves its engineering placement.
Existing saved DXFs remain site plans with their existing georeference behavior.

Use **Center on model**, numeric offsets, rotation and positive scale to align
the reference. Center is unavailable until the generated section contains a
finite model extent. Plane-reference offsets are in its registered U/V axes; site-plan
offsets retain their drawing-space convention. Visibility, opacity and CAD
layer controls apply in compatible 2D views. The independent 3D visibility
control puts vector paths on their registered plane. The 3D overlay currently
shows paths without hatches/text and uses opacity as an on/off gate.

**Import PDF/image...** opens the existing Appearance reference workflow
with the current cardinal plane suggested: Down uses IFC XY, Front uses IFC XZ,
and Side uses IFC YZ. Choose the source or PDF page, calibrate a known distance,
then explicitly place the reference. Underlays lists the committed raster
references with visibility, opacity, locking and removal controls. See
[Drawing references in 2D and 3D](appearance.md#drawing-references-in-2d-and-3d)
for calibration, editing and registration persistence.
This entry requires a generated cardinal drawing. It is unavailable on a custom
plane; already registered rasters can still be viewed and exported there.

Visible compatible references expand Fit and sheet bounds, including drawings
with no cut polygons. SVG, PDF and Print include the mapped DXF vectors and
committed raster references beneath the section geometry. Raw PDFs retain
vector section strokes while including raster reference imagery; sheet PDFs
retain the rasterized sheet layout. Four-corner raster placement, opacity and
CAD layer visibility agree with the display.

DXF exports include the visible mapped CAD vectors. Vertical section exports use
local section coordinates; they are not map-georeferenced IFC XY drawings. DXF
cannot embed the PDF/image raster references in this workflow, so the export
menu lists their omission before continuing. PDF and DXF still report visible
markup omissions. When a sheet is active, its scale governs PDF export and the
dialog explains why the scale cannot be changed there.

### Choosing a drawing export

| Output | Section geometry | Visible DXF references | Committed PDF/image references | Scale and coordinates |
| --- | --- | --- | --- | --- |
| SVG | Vector | Mapped vectors | Embedded raster images | Drawing or active sheet layout |
| PDF without a sheet | Vector strokes | Mapped vectors | Raster images beneath geometry | Chosen drawing scale; page fits the drawing |
| PDF with a sheet | Rasterized sheet | Included in the sheet image | Included in the sheet image | Active sheet scale and paper size |
| Print | Drawing/sheet SVG sent to the browser | Mapped vectors | Embedded raster images | Check the browser's paper size and scaling |
| DXF R12 | Vector, plus the scan outline on `SCAN-OUTLINE` when shown | Mapped vectors on export layers | Omitted, with confirmation | Metres; Down plans can use model/map coordinates, vertical sections use local section coordinates |

Only visible, compatible references are included. DXF layer visibility and raster
opacity follow the displayed drawing. Exporting a drawing does not embed workspace
registration recipes into IFC; see [reference sharing and persistence](appearance.md#drawing-references-in-2d-and-3d).

### Scan section outlines

With a point cloud loaded, the **Scan** tab of the drawing inspector overlays the scan points within a band around the section plane. Turn on **Vector outline** to trace them into closed rings: the boundary of what the scan shows as solid at the cut. The rings are drawn as lines over the cut and written to the DXF export on their own `SCAN-OUTLINE` layer, through the same coordinate transform as the cut, so a georeferenced plan puts them at map coordinates too.

**Bridge gaps up to** sets the widest gap the trace closes, about one wall thickness (5–50 cm, default 30 cm). It is what merges the two scanned faces of a wall into one solid band and closes scan shadows. Openings wider than it, such as doors, stay open. The trace uses every point in the band, not the decimated dots on screen. It runs in a worker, and only the latest plane or slider position is traced. The dots and the rings update together. The status line reports the ring count and the cell size. It also warns when the scan was too large for the cell budget and coarser cells were used. The engine is the wasm `traceScanOutline`; see [the WASM API](../api/wasm.md#scan-section-outlines).

### Troubleshooting section references

| Symptom | Check |
| --- | --- |
| DXF import requests units | Select the source units under **DXF units**, then import again. Placement scale does not replace unit conversion. |
| Reference disappears after changing the section | Check visibility and the registered plane. An edge-on reference has no projected area; return to a parallel section. A reference from another engineering frame needs registration in the current frame. |
| **Center on model** is disabled | Wait for a generated section with finite model geometry, and use a compatible reference plane. Reference-only bounds cannot supply a model center. |
| PDF appears in Appearance but not Underlays | Finish calibration and click **Place reference**. Choosing a source or previewing it does not commit a workspace reference. |
| Background edges remain at depth zero in Down | The plan's separate overhead band remains. Manual depth controls the background band. |
| Zoom changes but the PDF scale does not | Canvas zoom is a viewing control. Choose the PDF scale, or change the active sheet scale. |
| Raster reference is missing after importing registration JSON | Relink the exact original raster. Registration JSON contains placement and digests, not image bytes. |

For source provenance, inspected downloads and the limits of the browser tests,
see the [section validation evidence](../architecture/evidence/section-6614-6615/README.md).

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
| Scan → Vector outline | Off | Trace closed outlines from the scan points in the section band (see below) |
