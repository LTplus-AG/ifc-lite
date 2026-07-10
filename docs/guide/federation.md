# Multi-Model Federation

IFClite supports loading multiple IFC files simultaneously with unified selection, visibility, and spatial hierarchy. This is essential for real-world BIM workflows where architectural, structural, and MEP models are maintained as separate files.

## How It Works

Each loaded model is assigned a unique **ID offset** so that entity IDs never collide across models. The `FederationRegistry` manages these offsets automatically.

```
Model A: expressIds 1-5000    -> globalIds 1-5000       (offset: 0)
Model B: expressIds 1-3000    -> globalIds 5001-8000    (offset: 5000)
Model C: expressIds 1-2000    -> globalIds 8001-10000   (offset: 8000)
```

### Global vs Local IDs

- **Local expressId**: The original ID within a single IFC file (e.g., `#42`)
- **Global ID**: `expressId + model.idOffset` - unique across all loaded models
- **EntityRef**: `{ modelId: string, expressId: number }` - unambiguous reference to any entity

```typescript
import { federationRegistry } from '@ifc-lite/renderer';

// Convert local to global
const globalId = federationRegistry.toGlobalId('arch-model', expressId);

// Convert global to local
const lookup = federationRegistry.fromGlobalId(globalId);
// { modelId: 'arch-model', expressId: 42 }
```

## Loading Multiple Models

In the viewer, drop multiple IFC files or load them sequentially. Each model appears as a collapsible group in the hierarchy panel.

### Programmatic Usage

```typescript
import { IfcParser } from '@ifc-lite/parser';
import { federationRegistry } from '@ifc-lite/renderer';

const parser = new IfcParser();

// Load first model
const archStore = await parser.parseColumnar(archBuffer);
// Compute maxExpressId from entity index
const archMaxId = Math.max(...archStore.entityIndex.byId.keys());
const archOffset = federationRegistry.registerModel('arch', archMaxId);

// Load second model - IDs start after the first model's range
const structStore = await parser.parseColumnar(structBuffer);
const structMaxId = Math.max(...structStore.entityIndex.byId.keys());
const structOffset = federationRegistry.registerModel('struct', structMaxId);

// Convert IDs
const globalId = federationRegistry.toGlobalId('struct', 42);
const lookup = federationRegistry.fromGlobalId(globalId);
if (lookup) {
  console.log(`Model: ${lookup.modelId}, Express ID: ${lookup.expressId}`);
}
```

## Unified Interactions

When multiple models are loaded:

- **Selection** works across all models - clicking any entity in any model selects it
- **Visibility** can be toggled per-model or per-entity across models
- **Spatial hierarchy** shows all models as top-level groups, expandable to their internal structure
- **Properties panel** shows properties for the selected entity regardless of which model it belongs to
- **Section planes** cut through all visible models simultaneously
- **Measurements** can span across models

## Model Management

The viewer provides controls for each loaded model:

| Action | Description |
|--------|-------------|
| **Visibility toggle** | Show/hide an entire model |
| **Collapse/Expand** | Collapse a model's hierarchy tree |
| **Rename** | Give a model a descriptive name |
| **Remove** | Unload a model and free its ID range |
| **Set Active** | Focus the properties panel on a specific model |

## Merging to a Single File (CLI)

In-viewer federation keeps each model as a separate file with an ID offset. When
you instead want to bake several models into one physical IFC file, use the
`ifc-lite merge` command:

```bash
ifc-lite merge a.ifc b.ifc --out fed.ifc
```

Pass two or more input files (positional args) and one `--out` target. The
spatial hierarchy (sites, buildings, storeys) is unified by name and elevation by
default so the merged file has one coherent tree rather than duplicated
containers.

| Flag | Values | Default | Effect |
|------|--------|---------|--------|
| `--out <file>` | path | required | Output file path |
| `--schema` | `IFC2X3` / `IFC4` / `IFC4X3` | `IFC4` | Output schema version |
| `--unit-reconciliation` | `auto` / `normalize` / `assume-shared` | `auto` | How to handle models whose length unit differs from the first file. `auto` federates them as separate projects; `normalize` rescales them into the first file's unit; `assume-shared` forces one project without rescaling |
| `--merge-sites` | `single` / `by-name` | combined heuristic | How `IfcSite` records are matched across models |
| `--merge-buildings` | `single` / `by-name` | combined heuristic | How `IfcBuilding` records are matched |
| `--merge-storeys` | `by-name` / `by-elevation` / `by-name-then-elevation` | combined heuristic | How `IfcBuildingStorey` records are matched |
| `--json` | flag | off | Emit machine-readable stats (entity counts, warnings) to stdout |

## FederatedModel Type

Each loaded model is tracked as a `FederatedModel`:

```typescript
interface FederatedModel {
  id: string;            // Unique model identifier
  name: string;          // Display name
  idOffset: number;      // Global ID offset
  maxExpressId: number;  // Highest expressId in this model
  visible: boolean;      // Visibility state
  collapsed: boolean;    // Hierarchy tree state
}
```

## Performance Considerations

- Each model adds its entities to the shared spatial index and renderer
- Memory usage scales linearly with total entity count across all models
- The FederationRegistry resolves IDs in O(1) local->global, O(log N) global->local
- Visibility toggling per-model is O(1) (GPU-level filtering)
- Loading 5+ large models (100MB+ each) may require the server paradigm for best performance

## IFC5 Federated Layers

For IFC5 (IFCX) files, federation works differently - files can be loaded as **overlay layers** where later files override properties from earlier ones:

```typescript
import { parseFederatedIfcx } from '@ifc-lite/ifcx';

const result = await parseFederatedIfcx([
  { buffer: baseBuffer, name: 'base-model.ifcx' },
  { buffer: overlayBuffer, name: 'add-fire-rating.ifcx' },
]);

// Properties from the overlay take precedence
// Wall now has FireRating property from the overlay file
```

See the [IFC5 Parsing Guide](parsing.md) for more details on IFCX format support.
