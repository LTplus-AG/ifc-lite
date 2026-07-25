/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Node-hash v0 (docs/vision/spec/node-hash-v0.md).
 *
 * `computeNodeHash(kind, payload)` — the one canonical hash function for
 * every node kind in the building DAG. Two algorithms, tagged in the output
 * string so a verifier never has to guess which produced a given hash:
 *
 * - `geometry-mesh` leaves reuse the EXACT FNV-1a64 byte encoding pinned by
 *   `rust/processing/src/determinism.rs` / `mesh_determinism.json` — this
 *   file does not invent a new mesh serialization (spec §3.1).
 * - Composite/DAG kinds (`property-set`, `relationship`, `layer`, `element`)
 *   hash a canonical binary encoding (little-endian, length-prefixed UTF-8
 *   strings, sorted sets) with SHA-256 via WebCrypto — zero new
 *   dependencies, browser + Node 22 native (spec §3.2).
 *
 * Every hash is a tagged string, `"<algorithm>:<hex>"`, e.g.
 * `"fnv1a64:0x1234..."` or `"sha256:abcd..."`. A parent node's canonical
 * bytes embed its children's tagged hash strings (never their raw payload),
 * which is what makes the scheme Merkle (spec §3.5): changing a leaf changes
 * its own hash string, which changes every ancestor's canonical bytes, which
 * changes every ancestor's hash — and nothing else.
 *
 * Browser-safe: no Node-only APIs (`crypto.subtle` is the WebCrypto standard,
 * available in every evergreen browser and in Node via the global `crypto`).
 */

/* ------------------------------------------------------------------ */
/* FNV-1a64 — ported verbatim from rust/processing/src/determinism.rs   */
/* ------------------------------------------------------------------ */

const FNV_OFFSET_BASIS_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;
const MASK_64 = (1n << 64n) - 1n;

function fnv1aBytes64(h: bigint, bytes: Uint8Array): bigint {
  let acc = h;
  for (let i = 0; i < bytes.length; i++) {
    acc ^= BigInt(bytes[i]);
    acc = (acc * FNV_PRIME_64) & MASK_64;
  }
  return acc;
}

function u32LEBytes(v: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, v >>> 0, true);
  return buf;
}

function u64LEBytes(v: bigint): Uint8Array {
  const buf = new Uint8Array(8);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, Number(v & 0xffffffffn), true);
  dv.setUint32(4, Number((v >> 32n) & 0xffffffffn), true);
  return buf;
}

/** `f32` bit pattern, little-endian — matches Rust's `v.to_bits().to_le_bytes()`. */
function f32BitsLEBytes(v: number): Uint8Array {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setFloat32(0, v, true);
  return buf;
}

/** `f64` bit pattern, little-endian — matches Rust's `v.to_bits().to_le_bytes()`. */
function f64BitsLEBytes(v: number): Uint8Array {
  const buf = new Uint8Array(8);
  new DataView(buf.buffer).setFloat64(0, v, true);
  return buf;
}

function fnv1aF32Bits(h: bigint, vals: ArrayLike<number>): bigint {
  let acc = h;
  for (let i = 0; i < vals.length; i++) acc = fnv1aBytes64(acc, f32BitsLEBytes(vals[i]));
  return acc;
}

function fnv1aU32s(h: bigint, vals: ArrayLike<number>): bigint {
  let acc = h;
  for (let i = 0; i < vals.length; i++) acc = fnv1aBytes64(acc, u32LEBytes(vals[i]));
  return acc;
}

function hex64(h: bigint): string {
  return `0x${h.toString(16).padStart(16, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Node kinds and payloads (spec §2)                                    */
/* ------------------------------------------------------------------ */

export type NodeKind = 'geometry-mesh' | 'property-set' | 'relationship' | 'layer' | 'element';

/** One element's tessellated output — a DAG leaf. Mirrors the fields
 *  `rust/processing/src/determinism.rs` hashes per mesh (spec §3.1). */
export interface GeometryMeshPayload {
  expressId: number;
  /** 0-255; matches the wire `geometry_class` byte. */
  geometryClass: number;
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  indices: ArrayLike<number>;
  origin: readonly [number, number, number];
  /**
   * Optional RTC-invariant semantic hash (spec §3.1, decision Q2 2026-07-24):
   * the `rust/geometry/src/geom_hash.rs` value already exposed through the
   * wasm boundary as `geometryHashValues` (a u64). Carried as an ANNOTATION
   * for dedup/memoization ("the same door hashes the same in Tokyo and
   * Zurich") — it is deliberately NOT folded into the node hash, which stays
   * byte-exact so certificates prove deterministic replay. Certificates must
   * only ever claim over the node hash, never over this field.
   */
  semanticHash?: bigint | string;
}

export type PropertyValue = string | number | boolean | null;

export interface PropertySetPayload {
  name: string;
  properties: readonly { name: string; value: PropertyValue }[];
}

export interface RelationshipPayload {
  /** e.g. `"IfcRelVoidsElement"`. */
  relType: string;
  /** Each role (e.g. `RelatingBuildingElement`, `RelatedOpeningElements`) holds
   *  a set of child-hash references — sorted before hashing (spec §3.2). */
  roles: readonly { roleName: string; refs: readonly string[] }[];
}

export interface LayerPayload {
  /**
   * The layer document's own content identity (spec §3.4, decision Q1
   * 2026-07-24): the tagged blake3 hash produced by `packages/ifcx`'s
   * `computeLayerId` (`"blake3:<hex>"`). The DAG layer node EMBEDS the ifcx
   * identity rather than competing with it — one node carries both the
   * document identity (this field) and the effect commitment (childHashes),
   * and the node's own hash stays SHA-256 like every composite kind.
   */
  layerId: string;
  /** Tagged hashes of the element/entity nodes this layer's ops touch. */
  childHashes: readonly string[];
}

export interface ElementPayload {
  /** Stable cross-revision identity — typically the IFC `GlobalId`. */
  key: string;
  ifcType: string;
  /** `ComponentKey` vocabulary from `packages/diff/src/fingerprint.ts`
   *  (`attr:core`, `pset:<Name>`, `qset:<Name>`, `type-assignment`,
   *  `geometry-mesh`, `relationship:<RelType>`, ...) → child tagged hash. */
  components: readonly { componentKey: string; hash: string }[];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- documents the mapping used by computeNodeHash's overloads
type _PayloadForKind<K extends NodeKind> = K extends 'geometry-mesh'
  ? GeometryMeshPayload
  : K extends 'property-set'
    ? PropertySetPayload
    : K extends 'relationship'
      ? RelationshipPayload
      : K extends 'layer'
        ? LayerPayload
        : K extends 'element'
          ? ElementPayload
          : never;

export type PayloadForKind<K extends NodeKind> = _PayloadForKind<K>;

/** Discriminated union a {@link NodeResolver} returns — lets `verifyCertificate`
 *  recompute a hash without the caller needing separate lookup calls per kind. */
export type ResolvedNode =
  | { kind: 'geometry-mesh'; payload: GeometryMeshPayload }
  | { kind: 'property-set'; payload: PropertySetPayload }
  | { kind: 'relationship'; payload: RelationshipPayload }
  | { kind: 'layer'; payload: LayerPayload }
  | { kind: 'element'; payload: ElementPayload };

/* ------------------------------------------------------------------ */
/* geometry-mesh: FNV-1a64, verbatim determinism.rs encoding             */
/* ------------------------------------------------------------------ */

function computeGeometryMeshHash(payload: GeometryMeshPayload): string {
  let hp = FNV_OFFSET_BASIS_64;
  hp = fnv1aF32Bits(hp, payload.positions);

  let hn = FNV_OFFSET_BASIS_64;
  hn = fnv1aF32Bits(hn, payload.normals);

  let hio = FNV_OFFSET_BASIS_64;
  hio = fnv1aBytes64(hio, u32LEBytes(payload.expressId));
  hio = fnv1aBytes64(hio, Uint8Array.of(payload.geometryClass & 0xff));
  hio = fnv1aU32s(hio, payload.indices);
  for (const c of payload.origin) hio = fnv1aBytes64(hio, f64BitsLEBytes(c));

  let top = FNV_OFFSET_BASIS_64;
  top = fnv1aBytes64(top, u64LEBytes(hp));
  top = fnv1aBytes64(top, u64LEBytes(hn));
  top = fnv1aBytes64(top, u64LEBytes(hio));

  return `fnv1a64:${hex64(top)}`;
}

/* ------------------------------------------------------------------ */
/* Composite kinds: canonical binary encoding + SHA-256                 */
/* ------------------------------------------------------------------ */

const KIND_TAG: Record<Exclude<NodeKind, 'geometry-mesh'>, number> = {
  'property-set': 1,
  relationship: 2,
  layer: 3,
  element: 4,
};

/** Ordinal UTF-8 byte compare — NOT locale-aware, so sort order never
 *  depends on ICU/locale data across runtimes (spec §3.2). */
function compareUtf8(a: string, b: string): number {
  const ea = textEncoder.encode(a);
  const eb = textEncoder.encode(b);
  const len = Math.min(ea.length, eb.length);
  for (let i = 0; i < len; i++) {
    if (ea[i] !== eb[i]) return ea[i] - eb[i];
  }
  return ea.length - eb.length;
}

const textEncoder = new TextEncoder();

/** Growable little-endian byte writer implementing the common framing rules
 *  from spec §3.2 (magic header, length-prefixed strings, LE integers/floats). */
class ByteWriter {
  private readonly chunks: Uint8Array[] = [];

  u8(v: number): void {
    this.chunks.push(Uint8Array.of(v & 0xff));
  }

  u32(v: number): void {
    this.chunks.push(u32LEBytes(v));
  }

  f64(v: number): void {
    this.chunks.push(f64BitsLEBytes(v));
  }

  /** NFC-normalized, `u32` LE byte-length prefix, then UTF-8 bytes. */
  str(s: string): void {
    const bytes = textEncoder.encode(s.normalize('NFC'));
    this.u32(bytes.length);
    this.chunks.push(bytes);
  }

  /** 4-byte ASCII magic `"NHV0"` + 1-byte kind tag + 1-byte format version (0). */
  header(kind: Exclude<NodeKind, 'geometry-mesh'>): void {
    this.chunks.push(textEncoder.encode('NHV0'));
    this.u8(KIND_TAG[kind]);
    this.u8(0);
  }

  finish(): Uint8Array {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

function writePropertyValue(w: ByteWriter, value: PropertyValue): void {
  if (value === null) {
    w.u8(0);
  } else if (typeof value === 'string') {
    w.u8(1);
    w.str(value);
  } else if (typeof value === 'number') {
    w.u8(2);
    // Normalize -0 to 0 so it hashes identically to +0 (same rationale as
    // packages/ifcx/src/canonical.ts's canonicalStringify).
    w.f64(value === 0 ? 0 : value);
  } else if (typeof value === 'boolean') {
    w.u8(3);
    w.u8(value ? 1 : 0);
  } else {
    throw new Error(`@ifc-lite/provenance: unhashable property value: ${typeof value}`);
  }
}

function encodePropertySet(payload: PropertySetPayload): Uint8Array {
  const w = new ByteWriter();
  w.header('property-set');
  w.str(payload.name);
  const sorted = [...payload.properties].sort((a, b) => compareUtf8(a.name, b.name));
  w.u32(sorted.length);
  for (const p of sorted) {
    w.str(p.name);
    writePropertyValue(w, p.value);
  }
  return w.finish();
}

function encodeRelationship(payload: RelationshipPayload): Uint8Array {
  const w = new ByteWriter();
  w.header('relationship');
  w.str(payload.relType);
  const roles = [...payload.roles].sort((a, b) => compareUtf8(a.roleName, b.roleName));
  w.u32(roles.length);
  for (const role of roles) {
    w.str(role.roleName);
    const refs = [...role.refs].sort(compareUtf8);
    w.u32(refs.length);
    for (const ref of refs) w.str(ref);
  }
  return w.finish();
}

function encodeLayer(payload: LayerPayload): Uint8Array {
  const w = new ByteWriter();
  w.header('layer');
  w.str(payload.layerId);
  const children = [...payload.childHashes].sort(compareUtf8);
  w.u32(children.length);
  for (const c of children) w.str(c);
  return w.finish();
}

function encodeElement(payload: ElementPayload): Uint8Array {
  const w = new ByteWriter();
  w.header('element');
  w.str(payload.key);
  w.str(payload.ifcType);
  const comps = [...payload.components].sort((a, b) => compareUtf8(a.componentKey, b.componentKey));
  w.u32(comps.length);
  for (const c of comps) {
    w.str(c.componentKey);
    w.str(c.hash);
  }
  return w.finish();
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function getWebCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c?.subtle) {
    throw new Error(
      '@ifc-lite/provenance: WebCrypto (globalThis.crypto.subtle) is unavailable in this runtime',
    );
  }
  return c;
}

async function sha256Tagged(bytes: Uint8Array): Promise<string> {
  // BufferSource cast: our Uint8Arrays are always backed by plain ArrayBuffers,
  // but TS 5.7's generic typed arrays widen `buffer` to ArrayBufferLike.
  const digest = await getWebCrypto().subtle.digest('SHA-256', bytes as BufferSource);
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

/**
 * Compute the canonical node-hash-v0 hash for one DAG node.
 *
 * `geometry-mesh` resolves synchronously in practice but the function is
 * `async` uniformly across kinds, since the composite kinds must await
 * WebCrypto's `subtle.digest`.
 */
export async function computeNodeHash<K extends NodeKind>(
  kind: K,
  payload: PayloadForKind<K>,
): Promise<string> {
  switch (kind) {
    case 'geometry-mesh':
      return computeGeometryMeshHash(payload as GeometryMeshPayload);
    case 'property-set':
      return sha256Tagged(encodePropertySet(payload as PropertySetPayload));
    case 'relationship':
      return sha256Tagged(encodeRelationship(payload as RelationshipPayload));
    case 'layer':
      return sha256Tagged(encodeLayer(payload as LayerPayload));
    case 'element':
      return sha256Tagged(encodeElement(payload as ElementPayload));
    default: {
      const exhaustive: never = kind;
      throw new Error(`@ifc-lite/provenance: unknown node kind: ${String(exhaustive)}`);
    }
  }
}

/** Recompute the hash of a {@link ResolvedNode} — the shape a
 *  {@link NodeResolver} returns — dispatching to {@link computeNodeHash}. */
export async function hashResolvedNode(node: ResolvedNode): Promise<string> {
  switch (node.kind) {
    case 'geometry-mesh':
      return computeNodeHash('geometry-mesh', node.payload);
    case 'property-set':
      return computeNodeHash('property-set', node.payload);
    case 'relationship':
      return computeNodeHash('relationship', node.payload);
    case 'layer':
      return computeNodeHash('layer', node.payload);
    case 'element':
      return computeNodeHash('element', node.payload);
  }
}
