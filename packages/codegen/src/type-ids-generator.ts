/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Type IDs Generator
 *
 * Generates TypeScript type ID constants and lookup maps.
 */

import type { ExpressSchema } from './express-parser.js';
import { crc32, formatCRC32TableLiteral } from './crc32.js';

/**
 * Generate TypeScript type IDs file
 */
export function generateTypeIds(schema: ExpressSchema): string {
  let code = `/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * IFC Type IDs
 * Generated from EXPRESS schema: ${schema.name}
 *
 * CRC32 hashes for fast O(1) type lookup.
 *
 * DO NOT EDIT - This file is auto-generated
 */

/**
 * CRC32 Type IDs for all IFC entities
 */
export const TYPE_IDS = {
`;

  // Generate type IDs for all entities
  for (const entity of schema.entities) {
    const id = crc32(entity.name);
    code += `  ${entity.name}: ${id},\n`;
  }

  code += `} as const;

/**
 * Type for any valid type ID
 */
export type TypeId = (typeof TYPE_IDS)[keyof typeof TYPE_IDS];

/**
 * Reverse lookup: ID -> Name
 */
export const TYPE_NAMES: Record<number, string> = {
`;

  for (const entity of schema.entities) {
    const id = crc32(entity.name);
    code += `  ${id}: '${entity.name}',\n`;
  }

  code += `};

/**
 * Get type ID from name (case-insensitive)
 */
export function getTypeId(name: string): number | undefined {
  // Normalize to IfcXxx format
  const normalized = normalizeTypeName(name);
  return (TYPE_IDS as Record<string, number>)[normalized];
}

/**
 * Get type name from ID
 */
export function getTypeName(id: number): string | undefined {
  return TYPE_NAMES[id];
}

/**
 * Check if a type ID exists
 */
export function isValidTypeId(id: number): boolean {
  return id in TYPE_NAMES;
}

/**
 * Normalize type name to IfcXxx format
 */
function normalizeTypeName(name: string): string {
  // Handle IFCWALL -> IfcWall
  if (name.toUpperCase().startsWith('IFC')) {
    const rest = name.substring(3);
    // Find the entity that matches case-insensitively
    const upperRest = rest.toUpperCase();
    for (const key of Object.keys(TYPE_IDS)) {
      if (key.substring(3).toUpperCase() === upperRest) {
        return key;
      }
    }
  }
  return name;
}

/**
 * Calculate CRC32 hash for any string
 * (Useful for unknown types)
 */
export function crc32Hash(str: string): number {
  const upper = str.toUpperCase();
  let crc = 0xffffffff;
  for (let i = 0; i < upper.length; i++) {
    crc = CRC32_TABLE[(crc ^ upper.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// CRC32 lookup table
const CRC32_TABLE = new Uint32Array([
${formatCRC32TableLiteral('  ')}
]);
`;

  return code;
}
