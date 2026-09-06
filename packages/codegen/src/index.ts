/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * @ifc-lite/codegen
 *
 * IFC Code Generator - TypeScript and Rust from EXPRESS schemas
 *
 * Features:
 * - TypeScript interfaces from EXPRESS entities
 * - CRC32 type IDs for fast O(1) lookup
 * - Serialization support for IFC writing
 * - Rust type generation
 * - Schema metadata registry
 */

// Core parser
export {
  parseExpressSchema,
  getAllAttributes,
  getInheritanceChain,
  type ExpressSchema,
  type EntityDefinition,
  type AttributeDefinition,
  type TypeDefinition,
  type EnumDefinition,
  type SelectDefinition,
  type DerivedAttribute,
  type InverseAttribute,
} from './express-parser.js';

// TypeScript generation
export {
  generateTypeScript,
  writeGeneratedFiles,
  type GeneratedCode,
} from './typescript-generator.js';

// Type IDs (CRC32)
export { generateTypeIds } from './type-ids-generator.js';
export { crc32, generateTypeIds as generateTypeIdMap, findCollisions } from './crc32.js';

// Serialization
export { generateSerializers } from './serialization-generator.js';

// Rust generation
export { generateRust, type RustGeneratedCode } from './rust-generator.js';

// High-level generator
export {
  generateFromFile,
  generateFromSchema,
  generateAll,
  type FullGeneratedCode,
  type GeneratorOptions,
} from './generator.js';

// Schema-hierarchy helpers (runtime `isSubtypeOf`, against a generated
// bundle's `SCHEMA_REGISTRY` — see `./ifc4` and `./ifc4x3` subpath exports).
export {
  isSubtypeOf,
  isSubtypeOfAny,
  isProperSubtypeOf,
  isProperSubtypeOfAny,
  type HierarchyEntity,
  type HierarchyRegistry,
} from './schema-hierarchy.js';
