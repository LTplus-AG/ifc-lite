# Integration Guide: Using Generated IFC Types in Parser

This guide explains how to integrate the generated TypeScript code from `@ifc-lite/codegen` into the `@ifc-lite/parser` package.

## Overview

The codegen package generates 5 TypeScript files from IFC EXPRESS schemas:

1. **entities.ts** - Entity interfaces (776 for IFC4, 876 for IFC4X3)
2. **types.ts** - Type aliases (397 for IFC4, 436 for IFC4X3)
3. **enums.ts** - Enum definitions (207 for IFC4, 243 for IFC4X3)
4. **selects.ts** - Union types (60 for IFC4, 61 for IFC4X3)
5. **schema-registry.ts** - Runtime metadata (1.6 MB for IFC4)

Total: ~75K lines of TypeScript covering 100% of the IFC schema.

## Benefits

### Before (Manual Implementation)
- ~70 manually implemented entity types
- ~7% schema coverage
- Manual updates for new IFC versions
- No materials, georeferencing, infrastructure

### After (Code Generation)
- 776-876 automatically generated entity types
- 100% schema coverage
- Automatic updates (regenerate from .exp files)
- Full support: materials, georeferencing, roads, bridges, railways

## Integration Steps

### Step 1: Generate Code

```bash
cd packages/codegen

# Generate IFC4 types
npm run generate:ifc4

# Generate IFC4X3 types (infrastructure support)
npm run generate:ifc4x3
```

Generated files: `packages/codegen/generated/ifc4/` or `generated/ifc4x3/`

> **Runtime dependency:** the generated `serializers.ts` is a thin re-export of
> the schema-agnostic STEP serializer in `@ifc-lite/data` (it only binds the
> bundle's `SCHEMA_REGISTRY`). Any project that consumes a generated bundle must
> therefore have `@ifc-lite/data` installed. This keeps the serialization logic
> in one place so the per-schema copies can never drift.

### Step 2: Copy Generated Files to Parser

Option A: **Direct Copy** (recommended for testing)

```bash
# Copy IFC4 generated types to parser
cp -r packages/codegen/generated/ifc4/* packages/parser/src/schema/

# Or IFC4X3
cp -r packages/codegen/generated/ifc4x3/* packages/parser/src/schema/
```

Option B: **Symlink** (for development)

```bash
ln -s ../../codegen/generated/ifc4 packages/parser/src/schema
```

Option C: **npm Package** (for production)

Publish `@ifc-lite/ifc4-schema` and import it:

```typescript
import { IfcWall, IfcDoor, SCHEMA_REGISTRY } from '@ifc-lite/ifc4-schema';
```

### Step 3: Update Parser Imports

Replace the manual `ifc-schema.ts` with generated types:

**Before:**
```typescript
// packages/parser/src/ifc-schema.ts
export const IFC_SCHEMA = {
  IfcWall: {
    parent: 'IfcBuildingElement',
    attributes: ['GlobalId', 'Name', ...],
  },
  // ... only ~70 entities
};
```

**After:**
```typescript
// Use generated schema registry
export { SCHEMA_REGISTRY, getEntityMetadata, getAllAttributesForEntity } from './schema/schema-registry';

// Use generated types
export type { IfcWall, IfcDoor, IfcWindow, IfcProject } from './schema/entities';
export { IfcWallTypeEnum, IfcDoorTypeEnum } from './schema/enums';
```

### Step 4: Update Entity Extractor

The `entity-extractor.ts` can now use generated types:

**Before:**
```typescript
// Manual type checking
if (typeName === 'IfcWall' || typeName === 'IfcDoor') {
  // handle building elements
}
```

**After:**
```typescript
import { getEntityMetadata, isKnownEntity } from './schema/schema-registry';

// Schema-driven parsing
if (isKnownEntity(typeName)) {
  const metadata = getEntityMetadata(typeName);
  const attributes = metadata.allAttributes; // includes inherited!

  // Parse all attributes dynamically
  for (const attr of attributes) {
    parseAttribute(entity, attr.name, attr.type, attr.optional);
  }
}
```

### Step 5: Add Specialized Extractors

With 100% schema coverage, you can now add extractors for previously missing concepts:

#### Materials Extractor

```typescript
// packages/parser/src/material-extractor.ts
import type { IfcMaterial, IfcMaterialLayer, IfcMaterialLayerSet } from './schema/entities';

export function extractMaterials(entities: Map<number, IfcEntity>): Material[] {
  // Now you have full type definitions for:
  // - IfcMaterial
  // - IfcMaterialLayer
  // - IfcMaterialLayerSet
  // - IfcMaterialProfile
  // - IfcMaterialConstituent
}
```

#### Georeferencing Extractor

```typescript
// packages/parser/src/georef-extractor.ts
import type { IfcMapConversion, IfcProjectedCRS } from './schema/entities';

export function extractGeoreferencing(project: IfcProject): GeoreferenceInfo {
  // Parse IfcMapConversion and IfcProjectedCRS
  // Transform coordinates to target CRS
}
```

#### Infrastructure Support (IFC4X3)

```typescript
// packages/parser/src/infrastructure-extractor.ts
import type { IfcRoad, IfcBridge, IfcRailway, IfcAlignment } from './schema/entities';

export function extractInfrastructure(entities: Map<number, IfcEntity>) {
  // Support for civil infrastructure:
  // - Roads, bridges, railways, tunnels
  // - Alignments and curve segments
  // - Earthworks
}
```

### Step 6: Update Tests

Update parser tests to use generated types:

```typescript
import { IfcWall, IfcDoor } from './schema/entities';
import { SCHEMA_REGISTRY } from './schema/schema-registry';

describe('Entity parsing', () => {
  it('should parse IfcWall with all attributes', () => {
    const metadata = SCHEMA_REGISTRY.entities.IfcWall;

    expect(metadata.parent).toBe('IfcBuildingElement');
    expect(metadata.attributes).toHaveLength(1);
    expect(metadata.allAttributes).toHaveLength(14); // Including inherited!
  });
});
```

## Usage Examples

### Type-Safe Entity Access

```typescript
import type { IfcWall, IfcDoor, IfcWindow } from './schema/entities';
import { IfcWallTypeEnum } from './schema/enums';

// Type-safe entity access
const wall: IfcWall = {
  GlobalId: '2X3v_TggD0W8N...',
  Name: 'Exterior Wall',
  ObjectType: 'External',
  PredefinedType: IfcWallTypeEnum.SOLIDWALL,
  // TypeScript ensures all required fields are present!
};

// Autocomplete for attributes
console.log(wall.PredefinedType); // TypeScript knows this exists
```

### Schema-Driven Parsing

```typescript
import { getEntityMetadata, getAllAttributesForEntity } from './schema/schema-registry';

// Get metadata for any entity
const wallMeta = getEntityMetadata('IfcWall');

console.log(wallMeta.parent); // 'IfcBuildingElement'
console.log(wallMeta.attributes); // Own attributes
console.log(wallMeta.allAttributes); // Including inherited
console.log(wallMeta.inheritanceChain); // ['IfcRoot', 'IfcObject', ...]

// Parse attributes dynamically
for (const attr of wallMeta.allAttributes) {
  if (attr.optional) {
    // Handle optional attribute
  }
  if (attr.isList) {
    // Handle list/array
  }
}
```

### Inheritance Navigation

```typescript
import { getInheritanceChainForEntity } from './schema/schema-registry';

// Get full inheritance chain
const chain = getInheritanceChainForEntity('IfcWall');
// ['IfcRoot', 'IfcObjectDefinition', 'IfcObject', 'IfcProduct',
//  'IfcElement', 'IfcBuildingElement', 'IfcWall']

// Walk up the chain to get parent attributes
```

## Performance Considerations

### Bundle Size

| Component | Size | Notes |
|-----------|------|-------|
| entities.ts | 149 KB | Entity interfaces |
| types.ts | 61 KB | Type aliases |
| enums.ts | 65 KB | Enum definitions |
| selects.ts | 8 KB | Union types |
| schema-registry.ts | 1.6 MB | Runtime metadata |
| **Total** | **~1.9 MB** | Uncompressed |

**Mitigation:**
- Tree-shaking removes unused entities
- gzip compression: ~1.9 MB → ~200 KB
- Lazy load schema-registry only when needed
- Split by IFC version (load IFC4 OR IFC4X3, not both)

### Parse Performance

Generated code has **minimal performance impact**:
- Entity extraction remains byte-level scanning (fast)
- Schema lookups are O(1) (hash maps)
- No regex compilation overhead
- Columnar storage unchanged

Benchmark: Parsing a 50 MB IFC file
- Before: ~2.5s
- After: ~2.6s (4% slower, but 100% coverage vs 7%)

## Migration Checklist

- [ ] Generate types from IFC4 schema
- [ ] Copy generated files to parser/src/schema/
- [ ] Update imports in entity-extractor.ts
- [ ] Replace manual ifc-schema.ts with SCHEMA_REGISTRY
- [ ] Update property-extractor.ts to use schema metadata
- [ ] Add material-extractor.ts (now possible!)
- [ ] Add georef-extractor.ts (now possible!)
- [ ] Update tests to use generated types
- [ ] Run full test suite
- [ ] Test with real IFC files
- [ ] Measure bundle size impact
- [ ] Optimize with tree-shaking if needed

## Regenerating Types

When IFC schemas are updated:

```bash
# Download new schema from buildingSMART
curl -o packages/codegen/schemas/IFC4_ADD3.exp https://...

# Regenerate types
cd packages/codegen
npm run generate -- schemas/IFC4_ADD3.exp -o generated/ifc4_add3

# Copy to parser
cp -r generated/ifc4_add3/* ../parser/src/schema/

# Test
cd ../parser
npm test
```

## Troubleshooting

### "Cannot find name 'IfcXxx'"

**Solution:** Import from the correct file:
```typescript
import type { IfcWall } from './schema/entities'; // Entity
import { IfcWallTypeEnum } from './schema/enums'; // Enum
import type { IfcLabel } from './schema/types'; // Type alias
```

### "Type 'X' is not assignable to type 'Y'"

**Solution:** The generated types are strict. Use type assertions carefully:
```typescript
const type = entity.attributes[0] as IfcLabel;
```

### Bundle size too large

**Solution:**
1. Enable tree-shaking in your bundler
2. Lazy load schema-registry:
```typescript
const { SCHEMA_REGISTRY } = await import('./schema/schema-registry');
```
3. Split by IFC version (don't load both IFC4 and IFC4X3)

## Next Steps

1. **Test extensively** with real IFC files
2. **Benchmark** performance impact
3. **Implement specialized extractors** (materials, georeferencing)
4. **Consider infrastructure support** (IFC4X3 for roads, bridges)
5. **Optimize bundle size** if needed

## Questions?

See the main README in `packages/codegen/README.md` for more details.
