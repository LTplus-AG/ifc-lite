/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { ExpressSchema } from './express-parser.js';

const U64 = (1n << 64n) - 1n;
const HASH_MULTIPLIER = 0x9e3779b97f4a7c15n;
/** Shortest keyword the generated hash reads: two overlapping 4-byte words. */
const MIN_NAME_LENGTH = 4;

/**
 * 64-bit hash of an UPPERCASE STEP keyword: one multiply per 8-byte
 * little-endian word (the last word overlaps the one before it), seeded by
 * the length. Mirrored by the generated Rust `canonical_name_hash`.
 */
export function canonicalNameHash(name: string): bigint {
  const n = name.length;
  if (n < MIN_NAME_LENGTH) throw new Error(`STEP keywords have at least ${MIN_NAME_LENGTH} bytes: ${name}`);
  const word = (at: number, size: number) => {
    let value = 0n;
    for (let i = size - 1; i >= 0; i--) {
      const byte = name.charCodeAt(at + i);
      if (byte > 0x7f) throw new Error(`EXPRESS entity names are ASCII: ${name}`);
      value = (value << 8n) | BigInt(byte);
    }
    return value;
  };
  const step = (hash: bigint, value: bigint) => ((hash ^ value) * HASH_MULTIPLIER) & U64;
  let hash = (BigInt(n) * HASH_MULTIPLIER) & U64;
  if (n < 8) {
    hash = step(hash, word(0, 4) | (word(n - 4, 4) << 32n));
  } else {
    let at = 0;
    for (; at + 8 < n; at += 8) hash = step(hash, word(at, 8));
    hash = step(hash, word(n - 8, 8));
  }
  return hash ^ (hash >> 32n);
}

/** A minimal perfect hash over a schema's names (CHD, one displacement per bucket). */
export interface NameTable {
  /** Bucket of a name: the high hash word scaled to `displacements.length`. */
  displacements: number[];
  /** `slots[i]` is the name at slot `i`; every slot holds exactly one name. */
  slots: string[];
}

/** The slot the generated Rust computes for `hash` under `displacement`. */
export function nameSlot(hash: bigint, displacement: number, slotCount: number): number {
  const high = Number(hash >> 32n);
  const mixed = (Number(hash & 0xffffffffn) + Math.imul(displacement, high | 1)) >>> 0;
  return Number((BigInt(mixed) * BigInt(slotCount)) >> 32n);
}

/** The bucket the generated Rust computes for `hash`. */
export function nameBucket(hash: bigint, bucketCount: number): number {
  return Number(((hash >> 32n) * BigInt(bucketCount)) >> 32n);
}

/**
 * Place every name in its own slot. Buckets are filled largest first, each
 * with the smallest u16 displacement that lands all of its names on free
 * slots; when one has none, retry with smaller buckets. Deterministic.
 */
export function buildNameTable(names: string[]): NameTable {
  const hashes = new Map<bigint, string>();
  for (const name of names) {
    const hash = canonicalNameHash(name);
    const owner = hashes.get(hash);
    if (owner !== undefined) throw new Error(`canonical_name_hash collision: ${owner} and ${name}`);
    hashes.set(hash, name);
  }
  for (const namesPerBucket of [4, 3, 2, 1]) {
    const table = tryNameTable(names, Math.ceil(names.length / namesPerBucket));
    if (table) return table;
  }
  throw new Error(`no perfect name table for ${names.length} names`);
}

function tryNameTable(names: string[], bucketCount: number): NameTable | undefined {
  const buckets: { name: string; hash: bigint }[][] = Array.from({ length: bucketCount }, () => []);
  for (const name of names) {
    const hash = canonicalNameHash(name);
    buckets[nameBucket(hash, bucketCount)].push({ name, hash });
  }
  const order = buckets.map((_, i) => i).sort((a, b) => buckets[b].length - buckets[a].length || a - b);
  const slots: (string | undefined)[] = new Array(names.length).fill(undefined);
  const displacements: number[] = new Array(bucketCount).fill(0);
  for (const index of order) {
    const bucket = buckets[index];
    if (bucket.length === 0) break;
    let placed = false;
    for (let displacement = 0; displacement <= 0xffff && !placed; displacement++) {
      const targets = bucket.map(({ hash }) => nameSlot(hash, displacement, names.length));
      if (targets.every((slot, i) => slots[slot] === undefined && targets.indexOf(slot) === i)) {
        targets.forEach((slot, i) => (slots[slot] = bucket[i].name));
        displacements[index] = displacement;
        placed = true;
      }
    }
    if (!placed) return undefined;
  }
  return { displacements, slots: slots as string[] };
}

/**
 * One exact-name lookup shared by canonical and normalized input.
 *
 * A `match` on `&str` compiles to one length/memcmp test per arm, in order:
 * over the 1,021 names of the canonical registry that is a long, linear
 * chain of comparisons per call and a very large code footprint (68 KB of
 * x86 for the canonical lookup), which puts pressure on the instruction
 * cache (#7914).
 * A minimal perfect hash instead picks the one candidate type from two small
 * tables, and the candidate's own spelling verifies the hit, so a foreign name
 * comes back `None`. The tables are data, so the lookup is also smaller than
 * the `&str` match in the WASM bundle.
 */
export function generateTypeNameParser(schema: ExpressSchema): string {
  const names = schema.entities.map((entity) => entity.name.toUpperCase());
  const variants = new Map(schema.entities.map((entity) => [entity.name.toUpperCase(), entity.name]));
  const { displacements, slots } = buildNameTable(names);
  const lengths = names.map((name) => name.length);
  return `    /// Parse IFC type from string (case-insensitive)
    #[allow(clippy::should_implement_trait)]
    pub fn from_str(s: &str) -> Self {
        // #3987: recognized STEP names need no normalization scan.
        if let Some(known) = Self::from_canonical_name(s) {
            return known;
        }
        if s.bytes().all(|b| b.is_ascii() && !b.is_ascii_lowercase()) {
            return Self::Unknown(UnknownIfcType::new(s.to_owned()));
        }
        // Keep Unicode uppercase expansion and the exact unknown-type CRC.
        let upper = s.to_uppercase();
        Self::from_canonical_name(&upper)
            .unwrap_or_else(|| Self::Unknown(UnknownIfcType::new(upper)))
    }

    /// Perfect hash, then an exact compare: a \`&str\` match would test
    /// every name in turn (#7914). Every slot holds one schema name.
    fn from_canonical_name(s: &str) -> Option<Self> {
        const DISPLACEMENTS: [u16; ${displacements.length}] = [${displacements.join(', ')}];
        if !(${Math.min(...lengths)}..=${Math.max(...lengths)}).contains(&s.len()) {
            return None;
        }
        let hash = canonical_name_hash(s.as_bytes());
        let high = (hash >> 32) as u32;
        let bucket = (u64::from(high) * ${displacements.length}) >> 32;
        let displacement = u32::from(DISPLACEMENTS[bucket as usize]);
        let mixed = (hash as u32).wrapping_add(displacement.wrapping_mul(high | 1));
        let ifc_type = match (u64::from(mixed) * ${slots.length}) >> 32 {
${slots.map((name, slot) => `            ${slot} => Self::${variants.get(name)},`).join('\n')}
            _ => return None,
        };
        (ifc_type.as_str() == s).then_some(ifc_type)
    }

    /// Slots in \`from_canonical_name\`, one per schema name. The registry
    /// tests resolve that many distinct types, so none goes unexercised.
    #[cfg(test)]
    pub(crate) const CANONICAL_NAME_ARMS: usize = ${slots.length};
`;
}

/** The generated Rust twin of {@link canonicalNameHash}. */
export function generateCanonicalNameHash(): string {
  return `
/// 64-bit hash of an UPPERCASE STEP keyword of at least ${MIN_NAME_LENGTH} bytes, the key
/// of \`IfcType::from_canonical_name\`: one multiply per 8-byte word, so a
/// short hot name costs one or two. Codegen builds the perfect hash from it.
#[inline]
fn canonical_name_hash(bytes: &[u8]) -> u64 {
    const K: u64 = 0x9e37_79b9_7f4a_7c15;
    let n = bytes.len();
    let word = |at: usize| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
    let mut hash = (n as u64).wrapping_mul(K);
    if n < 8 {
        let head = u32::from_le_bytes(bytes[..4].try_into().unwrap());
        let tail = u32::from_le_bytes(bytes[n - 4..].try_into().unwrap());
        hash = (hash ^ (u64::from(head) | (u64::from(tail) << 32))).wrapping_mul(K);
    } else {
        let mut at = 0;
        while at + 8 < n {
            hash = (hash ^ word(at)).wrapping_mul(K);
            at += 8;
        }
        hash = (hash ^ word(n - 8)).wrapping_mul(K);
    }
    hash ^ (hash >> 32)
}
`;
}
