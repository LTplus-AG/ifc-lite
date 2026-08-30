// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::collate::{collate_refs, Collated, InstanceMeshRef};
use crate::mesh::Mesh;

// The instanced wire format — layout, the append-only field rule, and why header
// word 7 carries a STRIDE rather than flags — is documented once, at this
// module's front door in `instancing/mod.rs`. This file is that document's
// executable half and the spec the TS decoder
// (`packages/geometry/src/packed-instanced-decoder.ts`) mirrors.

/// `"IFNS"` little-endian — the instanced-shard magic the TS decoder validates.
pub const INSTANCED_MAGIC: u32 = 0x4946_4E53;
/// Instanced format version this encoder writes for a record that CARRIES
/// trailing field 1 (`item_id`). Decoders accept v1 and any version at or above
/// 2 that declares a valid stride, so this bumps only when a trailing field is
/// APPENDED — never to gate a read. Keep in lockstep with the TS decoder.
pub const INSTANCED_VERSION: u32 = 2;
/// Version written when the derived stride is the bare 88-byte base record: with
/// no trailing field such a shard IS a v1 shard byte for byte, header word 7's
/// literal `0` included, so it stays readable by a pre-#2985 build whose decoder
/// refuses every version but 1. Belt and braces beside the cache-key bump
/// (`@ifc-lite/cache` FORMAT_VERSION 15 → 16): bytes travel by other routes.
const INSTANCED_VERSION_BASE_RECORD: u32 = 1;

/// Instance record bytes BEFORE any trailing field: templateIndex(4) +
/// entityId(4) + color(16) + transform(64). Also the stride of a v1 shard, and
/// the floor every declared stride is validated against.
const INSTANCE_RECORD_BASE_BYTES: usize = 88;
/// Byte offset of trailing field 1, `item_id`, within an instance record.
const INSTANCE_ITEM_ID_OFFSET: usize = INSTANCE_RECORD_BASE_BYTES;
/// Stride of a record carrying trailing field 1 (`item_id`) and nothing after it.
const INSTANCE_RECORD_ITEM_ID_BYTES: usize = INSTANCE_ITEM_ID_OFFSET + 4;
/// Bytes a template record occupies (6× u32 + 3× f64).
const TEMPLATE_RECORD_BYTES: usize = 48;
/// Bytes the fixed header occupies (8× u32).
const HEADER_BYTES: usize = 32;

const INST_IDENTITY_F32: [f32; 16] = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];

/// A unique geometry decoded from an instanced shard.
#[derive(Debug, Clone)]
pub struct DecodedTemplate {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
    /// Per-template local origin (f64); world vertex = transform · (origin + position).
    pub origin: [f64; 3],
}

/// One occurrence of a decoded template.
#[derive(Debug, Clone)]
pub struct DecodedInstance {
    pub template_index: u32,
    pub entity_id: u32,
    pub color: [f32; 4],
    /// Row-major mat4 mapping the template's world geometry onto this occurrence.
    pub transform: [f32; 16],
    /// The `IfcRepresentationItem` this occurrence's geometry was tessellated
    /// from, so a host can drill from a rendered instanced piece back to the
    /// entity in the IFC source. `None` when the shard's stride declares no
    /// trailing item-id field (a v1 shard, or a model whose producer named no
    /// item at all) and when this record's own id is the `0` sentinel.
    pub item_id: Option<u32>,
}

/// A decoded instanced shard.
#[derive(Debug, Clone, Default)]
pub struct DecodedInstanced {
    pub templates: Vec<DecodedTemplate>,
    pub instances: Vec<DecodedInstance>,
}

/// Encode a [`Collated`] result + its source mesh views into an instanced shard.
/// Per-occurrence entity id + colour come from each `InstanceMeshRef`.
pub fn encode_refs(meshes: &[InstanceMeshRef], collated: &Collated) -> Vec<u8> {
    // (template mesh index, [(occurrence mesh index, rel transform)]).
    struct TSpec {
        mesh_idx: usize,
        instances: Vec<(usize, [f32; 16])>,
    }
    let mut tspecs: Vec<TSpec> = Vec::with_capacity(collated.templates.len() + collated.flat_indices.len());
    for t in &collated.templates {
        tspecs.push(TSpec {
            mesh_idx: t.template_index,
            instances: t.occurrences.iter().map(|o| (o.mesh_index, o.transform)).collect(),
        });
    }
    for &f in &collated.flat_indices {
        tspecs.push(TSpec {
            mesh_idx: f,
            instances: vec![(f, INST_IDENTITY_F32)],
        });
    }

    let template_count = tspecs.len();
    let instance_count: usize = tspecs.iter().map(|t| t.instances.len()).sum();
    let positions_len: usize = tspecs.iter().map(|t| meshes[t.mesh_idx].positions.len()).sum();
    let normals_len: usize = tspecs.iter().map(|t| meshes[t.mesh_idx].normals.len()).sum();
    let indices_len: usize = tspecs.iter().map(|t| meshes[t.mesh_idx].indices.len()).sum();

    // Wire offsets/lengths are u32 (header + template records). A pool exceeding
    // u32::MAX elements (>16GB of positions in ONE shard) would wrap SILENTLY and
    // corrupt template lookups. Fail loudly instead — the caller must chunk shards
    // below this (real instanced shards are <<1GB; this is an impossible-scale
    // backstop, not a normal limit).
    assert!(
        positions_len <= u32::MAX as usize
            && normals_len <= u32::MAX as usize
            && indices_len <= u32::MAX as usize
            && template_count <= u32::MAX as usize
            && instance_count <= u32::MAX as usize,
        "instanced shard exceeds u32 wire limits (pos={positions_len} idx={indices_len}); chunk it"
    );

    // The stride is derived from the DATA, not fixed at compile time. A model
    // whose producer named no representation item writes 88-byte records instead
    // of paying 4 bytes of zeros on every occurrence — roughly 800 KB on a 200k-
    // occurrence model, written, cached to IndexedDB verbatim, and re-read on
    // every load. It also closes a hole: `InstanceMeshRef::from_mesh` leaves
    // `item_id: None`, so a caller going through it can no longer produce a
    // shard that DECLARES the field and fills every record with 0 —
    // indistinguishable from "this model has no representation items".
    // Over the occurrence indices the instance loop below actually WALKS, not
    // over `meshes`: `collate_refs` drops members (an empty non-instanceable
    // mesh, an all-empty rep group), so a batch whose only id-bearing entry is
    // a dropped one would declare 92 and write 0 into every record — the exact
    // hole this predicate exists to close.
    let carries_item_id = tspecs
        .iter()
        .flat_map(|t| t.instances.iter())
        .any(|(occ_idx, _)| meshes[*occ_idx].item_id.is_some());
    // A base-record shard is declared v1, word 7 at the literal `0` v1 wrote
    // there: byte-identical to a pre-#2985 shard. Only a widened record is v2.
    let (version, instance_stride, stride_word) = if carries_item_id {
        (INSTANCED_VERSION, INSTANCE_RECORD_ITEM_ID_BYTES, INSTANCE_RECORD_ITEM_ID_BYTES as u32)
    } else {
        (INSTANCED_VERSION_BASE_RECORD, INSTANCE_RECORD_BASE_BYTES, 0u32)
    };

    let mut buf: Vec<u8> = Vec::with_capacity(
        HEADER_BYTES
            + template_count * TEMPLATE_RECORD_BYTES
            + instance_count * instance_stride
            + (positions_len + normals_len + indices_len) * 4,
    );
    let pu32 = |b: &mut Vec<u8>, v: u32| b.extend_from_slice(&v.to_le_bytes());
    let pf32 = |b: &mut Vec<u8>, v: f32| b.extend_from_slice(&v.to_le_bytes());
    let pf64 = |b: &mut Vec<u8>, v: f64| b.extend_from_slice(&v.to_le_bytes());

    // Header.
    pu32(&mut buf, INSTANCED_MAGIC);
    pu32(&mut buf, version);
    pu32(&mut buf, template_count as u32);
    pu32(&mut buf, instance_count as u32);
    pu32(&mut buf, positions_len as u32);
    pu32(&mut buf, normals_len as u32);
    pu32(&mut buf, indices_len as u32);
    pu32(&mut buf, stride_word);

    // Template table (running element offsets into the pooled data arrays).
    let (mut pos_off, mut nrm_off, mut idx_off) = (0u32, 0u32, 0u32);
    for t in &tspecs {
        let m = &meshes[t.mesh_idx];
        pu32(&mut buf, pos_off);
        pu32(&mut buf, m.positions.len() as u32);
        pu32(&mut buf, nrm_off);
        pu32(&mut buf, m.normals.len() as u32);
        pu32(&mut buf, idx_off);
        pu32(&mut buf, m.indices.len() as u32);
        pf64(&mut buf, m.origin[0]);
        pf64(&mut buf, m.origin[1]);
        pf64(&mut buf, m.origin[2]);
        pos_off += m.positions.len() as u32;
        nrm_off += m.normals.len() as u32;
        idx_off += m.indices.len() as u32;
    }

    // Instance table.
    for (ti, t) in tspecs.iter().enumerate() {
        for (occ_idx, transform) in &t.instances {
            pu32(&mut buf, ti as u32);
            pu32(&mut buf, meshes[*occ_idx].entity_id);
            for c in meshes[*occ_idx].color {
                pf32(&mut buf, c);
            }
            for v in transform {
                pf32(&mut buf, *v);
            }
            // Trailing field 1 (v2): the originating representation item, `0`
            // where this occurrence has none. The declared stride is what tells
            // a reader the field is here at all.
            //
            // The assert guards the direction that LOSES data: a record holding
            // an id the header made no room for would be dropped silently. The
            // other direction (declared ⇒ some record carries one) needs no
            // assert — `carries_item_id` IS that predicate, over exactly the
            // occurrences written here.
            debug_assert!(
                carries_item_id || meshes[*occ_idx].item_id.is_none(),
                "instance record carries an item id the declared stride has no room for"
            );
            if carries_item_id {
                pu32(&mut buf, meshes[*occ_idx].item_id.unwrap_or(0));
            }
        }
    }

    // Data pools.
    for t in &tspecs {
        for &p in meshes[t.mesh_idx].positions {
            pf32(&mut buf, p);
        }
    }
    for t in &tspecs {
        for &n in meshes[t.mesh_idx].normals {
            pf32(&mut buf, n);
        }
    }
    for t in &tspecs {
        for &i in meshes[t.mesh_idx].indices {
            pu32(&mut buf, i);
        }
    }
    buf
}

/// `encode_refs` over geometry `Mesh` values, with id/colour accessor closures
/// (thin wrapper, no geometry clone).
///
/// PREFER [`encode_refs`]. This wrapper cannot express the per-occurrence
/// `item_id` — a `Mesh` does not carry one and there is no closure for it — so
/// every shard it writes declares the 88-byte stride and no host can drill from
/// a rendered piece back to its representation item. It is kept because it is
/// published crate API; nothing in this repo calls it outside the tests.
pub fn encode_instanced(
    meshes: &[Mesh],
    collated: &Collated,
    entity_id: impl Fn(usize) -> u32,
    color: impl Fn(usize) -> [f32; 4],
) -> Vec<u8> {
    let refs: Vec<InstanceMeshRef> = meshes
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let mut r = InstanceMeshRef::from_mesh(m);
            r.entity_id = entity_id(i);
            r.color = color(i);
            r
        })
        .collect();
    encode_refs(&refs, collated)
}

/// One-shot producer: collate the mesh views into templates + instances and
/// encode them as an instanced shard. The caller (e.g. the native helper) builds
/// `InstanceMeshRef`s borrowing its own mesh storage — no geometry is cloned.
pub fn collate_and_encode(meshes: &[InstanceMeshRef], min_group: usize, rtc: [f64; 3]) -> Vec<u8> {
    let collated = collate_refs(meshes, min_group, rtc);
    encode_refs(meshes, &collated)
}

/// Decode an instanced shard. Returns None on a bad magic/version or truncation.
pub fn decode_instanced(bytes: &[u8]) -> Option<DecodedInstanced> {
    let ru32 = |o: usize| -> Option<u32> {
        bytes.get(o..o + 4).map(|s| u32::from_le_bytes(s.try_into().unwrap()))
    };
    let rf32 = |o: usize| -> Option<f32> {
        bytes.get(o..o + 4).map(|s| f32::from_le_bytes(s.try_into().unwrap()))
    };
    let rf64 = |o: usize| -> Option<f64> {
        bytes.get(o..o + 8).map(|s| f64::from_le_bytes(s.try_into().unwrap()))
    };
    // PERMISSIVE on version, STRICT on stride. Rejecting a version above this
    // build's would reject exactly the shards forward compatibility is for: a
    // v3 that APPENDS a trailing field is still fully readable here, because
    // every field this build knows sits at a fixed offset inside the base
    // record and the declared stride steps over the tail it does not know.
    // Refusing it would also have rejected the v1 shards already sitting in
    // browser caches, which persist IFNS bytes verbatim rather than re-encoding
    // — a silent loss of all instanced geometry on every existing entry.
    // Version 0 is not a version.
    let version = ru32(4)?;
    if ru32(0)? != INSTANCED_MAGIC || version == 0 {
        return None;
    }
    let template_count = ru32(8)? as usize;
    let instance_count = ru32(12)? as usize;
    let positions_len = ru32(16)? as usize;
    let normals_len = ru32(20)? as usize;
    let _indices_len = ru32(24)? as usize;
    // Word 7 is `reserved` in v1 and the instance record STRIDE from v2 on. v1
    // wrote a literal 0 there, which is not a legal stride, so both readings of
    // a v1 shard land on the 88-byte base record.
    let declared_stride = if version >= 2 { ru32(28)? as usize } else { 0 };
    let inst_bytes = if declared_stride == 0 {
        INSTANCE_RECORD_BASE_BYTES
    } else {
        declared_stride
    };
    // A stride below the base is not a shorter record, it is a corrupt header:
    // the base fields are not optional. Reading at it would slice each record
    // out of its predecessor's transform and yield plausible garbage. An
    // UNALIGNED stride is refused beside it, in BOTH languages: every field on
    // this wire is 4 bytes, so a boundary off a 4-byte multiple names no field,
    // and the TS decoder cannot even attempt one — it views the data pools as
    // `Float32Array` over the shard buffer, which throws an opaque `RangeError`
    // where this decoder used to read the same bytes happily.
    if inst_bytes < INSTANCE_RECORD_BASE_BYTES || inst_bytes % 4 != 0 {
        return None;
    }

    // Checked throughout: `instance_count` and the stride are both attacker-
    // controlled u32s, so their product overflows a 32-bit usize (wasm32) and
    // can reach 2^64 on a 64-bit host. An overflow here would wrap the data
    // offset back INSIDE the buffer and every bounds check below would pass.
    let tt_off = HEADER_BYTES;
    let it_off = tt_off.checked_add(template_count.checked_mul(TEMPLATE_RECORD_BYTES)?)?;
    let data_off = it_off.checked_add(instance_count.checked_mul(inst_bytes)?)?;
    let nrm_data = data_off.checked_add(positions_len.checked_mul(4)?)?;
    let idx_data = nrm_data.checked_add(normals_len.checked_mul(4)?)?;

    // A corrupt/hostile header can claim an arbitrary template_count or
    // instance_count. Bound both against the buffer we actually have BEFORE
    // sizing `Vec::with_capacity` below — otherwise a bogus huge count tries
    // to reserve gigabytes (or aborts the process via the allocator's OOM
    // handler) long before the per-field `ru32`/`rf32` reads below would ever
    // get a chance to fail gracefully and return `None`. This is also what
    // validates the declared stride against the buffer: a stride that does not
    // fit the instance table it describes cannot reach the data pools.
    if bytes.len() < data_off {
        return None;
    }

    // Byte offset of element `k` of the pool at `base` whose template range
    // starts at element `off` — checked against the same attacker-controlled
    // u32s, and what makes "Checked throughout" above true of the pool reads
    // too. On wasm32 (usize = 32 bits) `pos_off = 0xFFFFFFFF` overflows
    // `base + (off + k) * 4`: debug traps rather than returning the promised
    // `None`, release wraps back INSIDE the buffer and returns WRONG geometry.
    let elem = |base: usize, off: usize, k: usize| -> Option<usize> {
        base.checked_add(off.checked_add(k)?.checked_mul(4)?)
    };

    let mut templates = Vec::with_capacity(template_count);
    for t in 0..template_count {
        let r = tt_off + t * TEMPLATE_RECORD_BYTES;
        let pos_off = ru32(r)? as usize;
        let pos_len = ru32(r + 4)? as usize;
        let nrm_off = ru32(r + 8)? as usize;
        let nrm_len = ru32(r + 12)? as usize;
        let i_off = ru32(r + 16)? as usize;
        let i_len = ru32(r + 20)? as usize;
        let origin = [rf64(r + 24)?, rf64(r + 32)?, rf64(r + 40)?];
        let positions = (0..pos_len)
            .map(|k| rf32(elem(data_off, pos_off, k)?))
            .collect::<Option<Vec<f32>>>()?;
        let normals = (0..nrm_len)
            .map(|k| rf32(elem(nrm_data, nrm_off, k)?))
            .collect::<Option<Vec<f32>>>()?;
        let indices = (0..i_len)
            .map(|k| ru32(elem(idx_data, i_off, k)?))
            .collect::<Option<Vec<u32>>>()?;
        templates.push(DecodedTemplate { positions, normals, indices, origin });
    }

    let mut instances = Vec::with_capacity(instance_count);
    for i in 0..instance_count {
        let r = it_off + i * inst_bytes;
        let template_index = ru32(r)?;
        let entity_id = ru32(r + 4)?;
        let mut color = [0.0f32; 4];
        for (k, c) in color.iter_mut().enumerate() {
            *c = rf32(r + 8 + k * 4)?;
        }
        let mut transform = [0.0f32; 16];
        for (k, v) in transform.iter_mut().enumerate() {
            *v = rf32(r + 24 + k * 4)?;
        }
        // Trailing field 1, present only when the stride makes room for it.
        // Anything the stride reaches BEYOND it is a field appended by a newer
        // producer: skipped, not an error — that is the forward compatibility
        // the stride buys. 0 is the producer's "no item" sentinel (STEP names
        // start at #1), and a shard without the field has none at all — both
        // surface as None, so a consumer cannot tell an absent id apart from a
        // fabricated #0.
        let item_id = if inst_bytes >= INSTANCE_RECORD_ITEM_ID_BYTES {
            Some(ru32(r + INSTANCE_ITEM_ID_OFFSET)?).filter(|&id| id != 0)
        } else {
            None
        };
        instances.push(DecodedInstance { template_index, entity_id, color, transform, item_id });
    }
    Some(DecodedInstanced { templates, instances })
}
