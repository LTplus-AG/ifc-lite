/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * CRC32 Type ID Generator
 *
 * Generates consistent CRC32 hashes for IFC type names.
 * Used for fast O(1) type lookup in both TypeScript and Rust.
 *
 * This matches the algorithm used by web-ifc for compatibility.
 */

// Pre-computed CRC32 lookup table (IEEE polynomial)
const CRC32_TABLE = buildCRC32Table();

/**
 * Build the 256-entry CRC32 lookup table (reflected IEEE polynomial
 * 0xEDB88320). This is the single source of truth for the table: every
 * generated-code template that needs a literal copy of it (the TypeScript
 * `type-ids.ts` template and the Rust `schema.rs` template) MUST render it
 * from this function via {@link formatCRC32TableLiteral} rather than
 * hand-typing the 256 hex constants again. A hand-typed second copy is
 * exactly how two of its cells silently drifted from the values this
 * function produces (see CHANGELOG / the crc32-table-corruption fix).
 */
export function buildCRC32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

/**
 * Render {@link buildCRC32Table}'s 256 entries as a source-code literal body
 * (no surrounding brackets/braces — callers embed it in whatever container
 * syntax their target language uses), so the templates that need a static
 * CRC32 table literal can emit one without ever transcribing the values by
 * hand.
 *
 * @param indent   Leading whitespace for every line (matches the
 *                  surrounding template's indentation).
 * @param perLine  Values per line (default 6, matching the historical
 *                  hand-written layout so regeneration doesn't churn
 *                  unrelated formatting).
 */
export function formatCRC32TableLiteral(indent: string, perLine = 6): string {
  const table = buildCRC32Table();
  const hex = (n: number): string => `0x${n.toString(16).padStart(8, '0')}`;
  const lines: string[] = [];
  for (let i = 0; i < table.length; i += perLine) {
    const chunk = Array.from(table.slice(i, i + perLine), hex);
    lines.push(`${indent}${chunk.join(', ')},`);
  }
  return lines.join('\n');
}

/**
 * Calculate CRC32 hash for a string
 * @param str Input string (will be uppercased)
 * @returns 32-bit unsigned integer hash
 */
export function crc32(str: string): number {
  const upper = str.toUpperCase();
  let crc = 0xffffffff;
  for (let i = 0; i < upper.length; i++) {
    crc = CRC32_TABLE[(crc ^ upper.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Generate type IDs for all entities in a schema
 */
export function generateTypeIds(entityNames: string[]): Map<string, number> {
  const ids = new Map<string, number>();
  for (const name of entityNames) {
    ids.set(name, crc32(name));
  }
  return ids;
}

/**
 * Check for CRC32 collisions in a list of names
 * @returns Map of hash -> names[] for any collisions
 */
export function findCollisions(names: string[]): Map<number, string[]> {
  const hashToNames = new Map<number, string[]>();

  for (const name of names) {
    const hash = crc32(name);
    const existing = hashToNames.get(hash) || [];
    existing.push(name);
    hashToNames.set(hash, existing);
  }

  // Filter to only collisions
  const collisions = new Map<number, string[]>();
  for (const [hash, nameList] of hashToNames) {
    if (nameList.length > 1) {
      collisions.set(hash, nameList);
    }
  }

  return collisions;
}
