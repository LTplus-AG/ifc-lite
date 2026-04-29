# @ifc-lite/ifcx

IFC5 (IFCX) parser for IFClite. Parses the JSON-based IFCX format with ECS composition, USD geometry, and federated layer support — and writes IFCX too. Compatible with the existing IFClite data pipeline so you can mix IFC4 STEP and IFC5 IFCX in the same scene.

## Installation

```bash
npm install @ifc-lite/ifcx
```

## Parse an IFCX file

```typescript
import { parseIfcx } from '@ifc-lite/ifcx';

const buffer = await fetch('model.ifcx').then(r => r.arrayBuffer());

const result = await parseIfcx(buffer, {
  onProgress: ({ phase, percent }) => console.log(`${phase}: ${percent}%`),
});

console.log(`${result.entityCount} entities, ${result.meshes.length} pre-tessellated meshes`);
console.log(`Schema: ${result.schemaVersion}`); // 'IFC5'

// Same MeshData[] shape as @ifc-lite/parser — feed straight into renderer
renderer.loadGeometry(result.meshes);
```

## Auto-detect format

```typescript
import { detectFormat } from '@ifc-lite/ifcx';

const format = detectFormat(buffer);
// 'ifcx' | 'ifc' | 'glb' | 'unknown'

if (format === 'ifcx') {
  await parseIfcx(buffer);
} else if (format === 'ifc') {
  await ifcParser.parse(buffer); // @ifc-lite/parser
}
```

## Federated layers

IFCX supports overlays — a base file with the geometry, plus one or more layers that add or override properties. The package merges them in priority order:

```typescript
import { parseFederatedIfcx } from '@ifc-lite/ifcx';

const result = await parseFederatedIfcx([
  { buffer: baseBytes, name: 'architecture.ifcx' },
  { buffer: psetOverlayBytes, name: 'fire-safety-overlay.ifcx' },
  { buffer: scheduleOverlayBytes, name: 'construction-schedule.ifcx' },
]);

// Properties from later layers take precedence over earlier ones —
// fire-safety FireRating values overwrite anything in the base.
```

## Write IFCX

The package's writer ships with `@ifc-lite/export` as `Ifc5Exporter`. See the [Export package](../export/README.md) for the full write path. Quick example:

```typescript
import { Ifc5Exporter } from '@ifc-lite/export';

const exporter = new Ifc5Exporter(store, geometryResult);
const ifcx = exporter.export({ includeGeometry: true });
// ifcx.content → IFCX JSON string, save as .ifcx
```

## API

See the [Parsing Guide](../../docs/guide/parsing.md) and [API Reference](../../docs/api/typescript.md#ifc-liteifcx).

## License

[MPL-2.0](../../LICENSE)
