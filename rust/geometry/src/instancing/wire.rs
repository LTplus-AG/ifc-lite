// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::collate::{Collated, InstanceMeshRef};
use super::group::collate_refs;
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
pub(super) const INSTANCE_RECORD_BASE_BYTES: usize = 88;
/// Byte offset of trailing field 1, `item_id`, within an instance record.
pub(super) const INSTANCE_ITEM_ID_OFFSET: usize = INSTANCE_RECORD_BASE_BYTES;
/// Stride of a record carrying trailing field 1 (`item_id`) and nothing after it.
pub(super) const INSTANCE_RECORD_ITEM_ID_BYTES: usize = INSTANCE_ITEM_ID_OFFSET + 4;
/// Version written when a record carries trailing field 2, the finish (#5984).
pub(super) const INSTANCED_VERSION_FINISH: u32 = 3;
/// Byte offset of trailing field 2, `[metallic, roughness]` (2× f32, NaN =
/// unauthored), and the stride of a record carrying it. Field 1 precedes it
/// on such a record (fields are append-only), so its `item_id` is written too.
pub(super) const INSTANCE_FINISH_OFFSET: usize = INSTANCE_RECORD_ITEM_ID_BYTES;
const INSTANCE_RECORD_FINISH_BYTES: usize = INSTANCE_FINISH_OFFSET + 8;
/// Bytes a template record occupies (6× u32 + 3× f64).
pub(super) const TEMPLATE_RECORD_BYTES: usize = 48;
/// Bytes the fixed header occupies (8× u32).
pub(super) const HEADER_BYTES: usize = 32;

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
    encode_refs_with_finishes(meshes, collated, &[])
}

/// [`encode_refs`] plus each occurrence's IFC-authored finish (#5984):
/// `finishes[i]` is `meshes[i]`'s `[metallic, roughness]`, NaN where
/// unauthored, and a missing entry is unauthored. `InstanceMeshRef` is
/// published with public fields, so the finish travels beside it rather than
/// in it. Only a shard where some written occurrence authors a finish widens
/// its records to trailing field 2 (stride 100, version 3); every other shard
/// is byte-identical to [`encode_refs`]'s, so a model without finishes pays
/// nothing. Read back with [`super::decode_instance_finishes`].
pub fn encode_refs_with_finishes(meshes: &[InstanceMeshRef], collated: &Collated, finishes: &[[f32; 2]]) -> Vec<u8> {
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
    let finish_of = |i: usize| finishes.get(i).copied().unwrap_or([f32::NAN; 2]);
    let carries_finish = tspecs
        .iter()
        .flat_map(|t| t.instances.iter())
        .any(|(occ_idx, _)| finish_of(*occ_idx).iter().any(|v| v.is_finite()));
    // Field 2 sits after field 1, so carrying it carries field 1 as well.
    let carries_item_id = carries_finish
        || tspecs
            .iter()
            .flat_map(|t| t.instances.iter())
            .any(|(occ_idx, _)| meshes[*occ_idx].item_id.is_some());
    // A base-record shard is declared v1, word 7 at the literal `0` v1 wrote
    // there: byte-identical to a pre-#2985 shard. Only a widened record is v2.
    let (version, instance_stride, stride_word) = if carries_finish {
        (INSTANCED_VERSION_FINISH, INSTANCE_RECORD_FINISH_BYTES, INSTANCE_RECORD_FINISH_BYTES as u32)
    } else if carries_item_id {
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
            // Trailing field 2 (v3, #5984): the occurrence's finish.
            if carries_finish {
                for v in finish_of(*occ_idx) {
                    pf32(&mut buf, if v.is_finite() { v } else { f32::NAN });
                }
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
