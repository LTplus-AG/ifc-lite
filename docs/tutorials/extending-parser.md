# Extending the Parser

Learn to extend IFClite with custom functionality.

## Extension Points

```mermaid
flowchart TB
    subgraph Parser["Parser Extensions"]
        Custom["Custom Decoders"]
        Schema["Schema Extensions"]
    end

    subgraph Geometry["Geometry Extensions"]
        Processor["Custom Processors"]
        Profile["Profile Handlers"]
    end

    subgraph Renderer["Renderer Extensions"]
        Shader["Custom Shaders"]
        Material["Material System"]
    end

    Parser --> Geometry --> Renderer
```

## Custom Entity Decoders

### Creating a Decoder

```typescript
import { EntityDecoder, DecodedEntity } from '@ifc-lite/parser';

// Define custom entity interface
interface CustomDoorData {
  expressId: number;
  globalId: string;
  name: string;
  width: number;
  height: number;
  isExternal: boolean;
  fireRating: number;
}

// Create custom decoder
class DoorDecoder {
  constructor(
    private store: IfcDataStore,
    private buffer: Uint8Array
  ) {}

  decode(entity: EntityRef): CustomDoorData {
    // Use on-demand extraction for properties
    const props = extractPropertiesOnDemand(this.store, entity.expressId, this.buffer);
    const quantities = extractQuantitiesOnDemand(this.store, entity.expressId, this.buffer);

    return {
      expressId: entity.expressId,
      globalId: entity.globalId,
      name: entity.name || 'Unknown Door',
      width: quantities?.Width?.value || 0,
      height: quantities?.Height?.value || 0,
      isExternal: props?.['Pset_DoorCommon']?.IsExternal || false,
      fireRating: props?.['Pset_DoorCommon']?.FireRating || 0
    };
  }

  decodeAll(): CustomDoorData[] {
    const doorIds = this.store.entityIndex.byType.get('IFCDOOR') ?? [];
    return doorIds.map(id => {
      const ref = this.store.entityIndex.byId.get(id)!;
      return this.decode(ref);
    });
  }
}

// Usage
import { extractPropertiesOnDemand, extractQuantitiesOnDemand } from '@ifc-lite/parser';

const buffer = new Uint8Array(arrayBuffer);
const doorDecoder = new DoorDecoder(store, buffer);
const doors = doorDecoder.decodeAll();
```

### Streaming Decoder

Stream and decode entities as geometry is processed:

```typescript
import { GeometryProcessor } from '@ifc-lite/geometry';
import { IfcParser, type IfcDataStore, extractPropertiesOnDemand } from '@ifc-lite/parser';

class StreamingDecoder<T> {
  private handlers = new Map<string, (expressId: number, store: IfcDataStore, buffer: Uint8Array) => T>();

  register(type: string, handler: (expressId: number, store: IfcDataStore, buffer: Uint8Array) => T): void {
    this.handlers.set(type, handler);
  }

  async *decode(
    store: IfcDataStore,
    buffer: Uint8Array,
    geometry: GeometryProcessor
  ): AsyncGenerator<T> {
    for await (const event of geometry.processStreaming(buffer)) {
      if (event.type === 'batch') {
        for (const mesh of event.meshes) {
          const entityRef = store.entityIndex.byId.get(mesh.expressId);
          if (entityRef) {
            const handler = this.handlers.get(entityRef.type);
            if (handler) {
              yield handler(mesh.expressId, store, buffer);
            }
          }
        }
      }
    }
  }
}

// Usage
const decoder = new StreamingDecoder<CustomDoorData>();
decoder.register('IFCDOOR', (expressId, store, buffer) => {
  const props = extractPropertiesOnDemand(store, expressId, buffer);
  return {
    expressId,
    fireRating: props?.['Pset_DoorCommon']?.FireRating || 0,
    // ... decode door
  };
});

for await (const door of decoder.decode(store, buffer, geometry)) {
  console.log(door);
}
```

## Custom Geometry Processors

### Processor Interface

```typescript
import { GeometryProcessor, Mesh, Entity } from '@ifc-lite/geometry';

interface ProcessorContext {
  decoder: EntityDecoder;
  quality: 'FAST' | 'BALANCED' | 'HIGH';
}

abstract class GeometryProcessor {
  abstract canProcess(entity: Entity): boolean;
  abstract process(entity: Entity, context: ProcessorContext): Mesh | null;
}
```

### Example: Custom Profile Processor

```typescript
class CustomProfileProcessor extends GeometryProcessor {
  canProcess(entity: Entity): boolean {
    // Handle custom profile types
    return entity.type === 'IFCARBITRARYCLOSEDPROFILEDEF' &&
           this.hasCustomAttributes(entity);
  }

  process(entity: Entity, context: ProcessorContext): Mesh | null {
    const profile = this.extractProfile(entity, context.decoder);

    // Custom triangulation logic
    const points = this.convertToPoints(profile);
    const indices = this.triangulate(points);

    // Build mesh
    return this.buildMesh(entity.expressId, points, indices);
  }

  private extractProfile(entity: Entity, decoder: EntityDecoder): Point2[] {
    // Custom profile extraction
    const curve = decoder.decode(entity.attributes[0].value);
    return this.curveToPoints(curve);
  }

  private triangulate(points: Point2[]): number[] {
    // Use earcut or custom algorithm
    return earcut(points.flat(), [], 2);
  }
}
```

### Registering Custom Processors

```typescript
import { GeometryRouter, ProcessorRegistry } from '@ifc-lite/geometry';

// Register globally
ProcessorRegistry.register(new CustomProfileProcessor());

// Or per-instance
const router = new GeometryRouter();
router.addProcessor(new CustomProfileProcessor());

// Process metadata with the canonical columnar parser, then route custom
// geometry through GeometryProcessor/Rust processors.
const store = await parser.parseColumnar(buffer);
```

## Schema Extensions

### Adding Custom Entity Types

```typescript
import { SchemaRegistry, EntityDefinition } from '@ifc-lite/parser';

// Define custom entity
const customEntity: EntityDefinition = {
  name: 'IFCCUSTOMELEMENT',
  parent: 'IFCBUILDINGELEMENT',
  attributes: [
    { name: 'CustomProperty', type: 'STRING', optional: true },
    { name: 'CustomValue', type: 'REAL', optional: true }
  ]
};

// Register
SchemaRegistry.register(customEntity);

// Schema extensions must be generated into the parser package before parsing.
const store = await parser.parseColumnar(buffer);
const customs = store.entityIndex.byType.get('IFCCUSTOMELEMENT') ?? [];
```

### Custom Property Extractors

```typescript
import { PropertyExtractor } from '@ifc-lite/parser';

class CustomPropertyExtractor extends PropertyExtractor {
  extract(entity: Entity, decoder: EntityDecoder): Record<string, any> {
    const base = super.extract(entity, decoder);

    // Add custom properties
    if (entity.type === 'IFCWALL') {
      base.customProperty = this.computeCustomProperty(entity);
    }

    return base;
  }

  private computeCustomProperty(entity: Entity): number {
    // Custom calculation
    return 42;
  }
}
```

## Renderer Extensions

### Custom Shaders

```typescript
import { Renderer, ShaderModule } from '@ifc-lite/renderer';

const customVertexShader = `
  struct Uniforms {
    viewProjection: mat4x4<f32>,
    model: mat4x4<f32>,
    customParam: f32,
  }

  @group(0) @binding(0) var<uniform> uniforms: Uniforms;

  @vertex
  fn main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
    // Custom vertex transformation
    let modified = position * uniforms.customParam;
    return uniforms.viewProjection * uniforms.model * vec4(modified, 1.0);
  }
`;

const customFragmentShader = `
  @fragment
  fn main() -> @location(0) vec4<f32> {
    // Custom fragment coloring
    return vec4(1.0, 0.0, 0.0, 1.0);
  }
`;

// Note: Custom shader registration is an advanced feature
// Requires extending the renderer's pipeline
```

!!! note "Custom Rendering"
    Custom shaders and dynamic per-entity coloring are advanced features
    not exposed in the current public API. For custom rendering needs,
    consider extending the Renderer class or contributing to the project.

### Visibility-Based Highlighting

For highlighting specific entities, use visibility controls:

```typescript
interface HighlightManager {
  isolated: Set<number>;
  hidden: Set<number>;
  selected: Set<number>;
}

class HighlightManager {
  isolated: Set<number> | null = null;
  hidden = new Set<number>();
  selected = new Set<number>();

  isolate(expressIds: number[]): void {
    this.isolated = new Set(expressIds);
  }

  hide(expressIds: number[]): void {
    expressIds.forEach(id => this.hidden.add(id));
  }

  select(expressIds: number[]): void {
    this.selected = new Set(expressIds);
  }

  clearAll(): void {
    this.isolated = null;
    this.hidden.clear();
    this.selected.clear();
  }

  applyToRenderer(renderer: Renderer): void {
    renderer.render({
      isolatedIds: this.isolated,
      hiddenIds: this.hidden,
      selectedIds: this.selected
    });
  }
}
```

## Plugin System

### Creating a Plugin

```typescript
interface IfcLitePlugin {
  name: string;
  version: string;

  // Lifecycle hooks
  onInit?(context: PluginContext): void;
  onParse?(store: IfcDataStore): void;
  onGeometry?(meshes: Mesh[]): void;
  onRender?(renderer: Renderer): void;
  onDispose?(): void;
}

interface PluginContext {
  parser: IfcParser;
  renderer: Renderer;
  query: IfcQuery;
}

// Example plugin
class AnalyticsPlugin implements IfcLitePlugin {
  name = 'analytics';
  version = '1.0.0';

  onParse(store: IfcDataStore): void {
    console.log('Parse statistics:', {
      entities: store.entityCount,
      schema: store.schema,
    });
  }
}
```

### Plugin Manager

```typescript
class PluginManager {
  private plugins: IfcLitePlugin[] = [];

  register(plugin: IfcLitePlugin): void {
    this.plugins.push(plugin);
    console.log(`Registered plugin: ${plugin.name} v${plugin.version}`);
  }

  async init(context: PluginContext): Promise<void> {
    for (const plugin of this.plugins) {
      await plugin.onInit?.(context);
    }
  }

  onParse(store: IfcDataStore): void {
    for (const plugin of this.plugins) {
      plugin.onParse?.(store);
    }
  }

  // ... other lifecycle methods
}

// Usage
const plugins = new PluginManager();
plugins.register(new AnalyticsPlugin());

const store = await parser.parseColumnar(buffer);
plugins.onParse(store);
```

## Best Practices

### 1. Keep Extensions Focused

```typescript
// Good: Single responsibility
class FireRatingExtractor {
  extract(entity: Entity): number | null { ... }
}

// Bad: Too many responsibilities
class EverythingExtractor {
  extractFireRating(entity: Entity): number { ... }
  extractMaterials(entity: Entity): Material[] { ... }
  triangulateGeometry(entity: Entity): Mesh { ... }
  // ...
}
```

### 2. Use TypeScript Generics

```typescript
class TypedDecoder<T> {
  constructor(
    private decode: (entity: Entity) => T
  ) {}

  decodeAll(entities: Entity[]): T[] {
    return entities.map(this.decode);
  }
}

const doorDecoder = new TypedDecoder<CustomDoorData>(decodeDoor);
```

### 3. Handle Errors Gracefully

```typescript
class SafeProcessor extends GeometryProcessor {
  process(entity: Entity, context: ProcessorContext): Mesh | null {
    try {
      return this.doProcess(entity, context);
    } catch (error) {
      console.warn(`Failed to process ${entity.type} #${entity.expressId}:`, error);
      return null; // Return null instead of throwing
    }
  }
}
```

## Next Steps

- [API Reference](../api/typescript.md) - Full API documentation
- [Architecture](../architecture/overview.md) - System design
