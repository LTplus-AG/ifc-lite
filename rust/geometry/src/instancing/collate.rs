// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::verify::verify_pairing;
use crate::mesh::{InstanceMeta, Mesh};
use nalgebra::Matrix4;
use rustc_hash::FxHashMap;

const IDENTITY16: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 0.0, 1.0, //
];

/// Full world transform `transform · local_transform` for an occurrence.
pub(super) fn compose_world(meta: &InstanceMeta) -> Matrix4<f64> {
    let t = Matrix4::from_row_slice(&meta.transform);
    let l = Matrix4::from_row_slice(meta.local_transform.as_ref().unwrap_or(&IDENTITY16));
    // Rigid tier: canonical->local transform, composed innermost. For occurrences
    // grouped by congruence (not bit-identity) this carries the recovered rotation
    // so the shared template reproduces this occurrence's baked geometry.
    let c = Matrix4::from_row_slice(meta.canonical_transform.as_ref().unwrap_or(&IDENTITY16));
    t * l * c
}

/// Flatten a column-major nalgebra matrix into a row-major `[f32; 16]`.
pub(super) fn mat4_to_row_major_f32(m: &Matrix4<f64>) -> [f32; 16] {
    let mut out = [0.0f32; 16];
    for r in 0..4 {
        for c in 0..4 {
            out[r * 4 + c] = m[(r, c)] as f32;
        }
    }
    out
}

/// One occurrence of a template geometry.
#[derive(Debug, Clone)]
pub struct InstanceOccurrence {
    /// Index of the original mesh in the input slice (carries entity id / colour).
    pub mesh_index: usize,
    /// Row-major mat4 mapping the template's baked world geometry onto this
    /// occurrence. The template occurrence's transform is identity.
    pub transform: [f32; 16],
}

/// A unique geometry shared by two or more occurrences.
#[derive(Debug, Clone)]
pub struct InstanceTemplate {
    /// Representation-identity key (RepresentationMap id for mapped items).
    pub rep_identity: u128,
    /// Index of the mesh whose geometry is the template to upload.
    pub template_index: usize,
    /// Every occurrence (including the template itself, with identity transform).
    pub occurrences: Vec<InstanceOccurrence>,
}

/// Result of collation: instanced templates + the meshes left to render flat.
#[derive(Debug, Clone, Default)]
pub struct Collated {
    /// Unique geometries with their per-instance transforms.
    pub templates: Vec<InstanceTemplate>,
    /// Indices of input meshes rendered without instancing (non-instanceable,
    /// singleton groups, or groups that failed the geometry-shape guard).
    pub flat_indices: Vec<usize>,
}

impl Collated {
    /// Total number of unique geometries that would be uploaded (templates +
    /// flat meshes) — the figure that bounds browser ingestion.
    pub fn unique_geometry_count(&self) -> usize {
        self.templates.len() + self.flat_indices.len()
    }

    /// Total occurrences represented across all templates (excludes flat meshes).
    pub fn instanced_occurrence_count(&self) -> usize {
        self.templates.iter().map(|t| t.occurrences.len()).sum()
    }
}

/// A borrowed view of a mesh for collation/encoding — lets callers feed geometry
/// from any owner (geometry's `Mesh`, processing's `MeshData`) WITHOUT cloning the
/// vertex data (cloning 219k meshes' geometry risks the build-container OOM).
pub struct InstanceMeshRef<'a> {
    pub positions: &'a [f32],
    pub normals: &'a [f32],
    pub indices: &'a [u32],
    pub origin: [f64; 3],
    pub instance_meta: Option<&'a InstanceMeta>,
    /// Per-occurrence entity id (used only by the encoder).
    pub entity_id: u32,
    /// Per-occurrence RGBA (used only by the encoder).
    pub color: [f32; 4],
    /// The `IfcRepresentationItem` this occurrence's geometry was tessellated
    /// from (`MeshData::geometry_item_id`) — the host's drill-to-source link,
    /// used only by the encoder. `Option` like every other link in the chain
    /// (`RawInstanceOccurrence`, `InstanceRecord`, `DecodedInstance::item_id`), so
    /// no caller can pass a meaningful-looking `0`; the encoder collapses `None`
    /// to the wire's `0` once, where that sentinel is a wire fact.
    pub item_id: Option<u32>,
}

impl<'a> InstanceMeshRef<'a> {
    /// Build a view over a geometry `Mesh` (encoder id/colour default to 0).
    pub fn from_mesh(m: &'a Mesh) -> Self {
        InstanceMeshRef {
            positions: &m.positions,
            normals: &m.normals,
            indices: &m.indices,
            origin: m.origin,
            instance_meta: m.instance_meta.as_ref(),
            entity_id: 0,
            color: [0.0; 4],
            item_id: None,
        }
    }
}

/// Subtract the model RTC offset from a composed (pre-RTC) world transform's
/// translation column, giving the post-RTC placement that matches the post-RTC
/// per-mesh `origin` the renderer applies the relative transform to.
pub(super) fn to_post_rtc(mut m: Matrix4<f64>, rtc: [f64; 3]) -> Matrix4<f64> {
    m[(0, 3)] -= rtc[0];
    m[(1, 3)] -= rtc[1];
    m[(2, 3)] -= rtc[2];
    m
}

/// Group instanceable meshes by representation identity into templates +
/// per-instance transforms. `min_group` is the smallest occurrence count worth
/// instancing (groups below it are emitted flat); use 2 to instance any repeat.
///
/// `rtc` is the model RTC offset (`InstanceMeta.transform` is documented pre-RTC
/// at georeferenced magnitude, while each mesh's baked `origin` is post-RTC and
/// small). The per-occurrence relative transform is computed in the post-RTC
/// frame: on raw absolute placements `rel = m_k · m_ref⁻¹` lets a *rotated*
/// occurrence's translation reach `T_k − R_rel·T_ref ≈ 2× rtc` (the two ~1e6 m
/// terms add instead of cancel), which then places the occurrence at twice the
/// georeference and collapses f32 GLB exports. Reducing both transforms by `rtc`
/// first keeps `rel.translation` at building scale and consistent with the small
/// template origin.
///
/// `InstanceMeta.transform` (hence `rel`) is native-frame (IFC Z-up); positions
/// must share that frame — see [`collate_refs_verified_in`] otherwise.
pub fn collate_refs(meshes: &[InstanceMeshRef], min_group: usize, rtc: [f64; 3]) -> Collated {
    collate_refs_verified_in(meshes, min_group, rtc, None)
}

/// [`collate_refs`], but the #3666 reconstruction check compares in a
/// caller-supplied basis — see [`super::verify`]'s module doc.
pub fn collate_refs_verified_in(
    meshes: &[InstanceMeshRef],
    min_group: usize,
    rtc: [f64; 3],
    verify_basis: Option<&Matrix4<f64>>,
) -> Collated {
    // A `verify_basis` that cannot be inverted has no conjugation `S · rel · S⁻¹`.
    // This once degraded to `None` — "no basis given" — which compares an
    // UNCONJUGATED `rel` against baked vertices the caller has just said are in a
    // DIFFERENT frame: the one comparison known to be wrong, reported as verified.
    // A singular basis is a caller bug, so reject outright: nothing is instanced
    // and every drawable mesh still draws, flat. That costs sharing (loud, and
    // visible in the export's size) rather than shipping a mis-grouped occurrence
    // (silent, and wrong on screen).
    let verify_conjugate = match verify_basis {
        None => None,
        Some(s) => match s.try_inverse() {
            Some(s_inv) => Some((*s, s_inv)),
            None => {
                crate::diag::diag_warn!(
                    { "instancing: verify_basis is singular; refusing the whole collation (nothing instanced, every drawable mesh still drawn flat)" }
                    else {
                        #[cfg(any(debug_assertions, test))]
                        eprintln!(
                            "[instancing] verify_basis is singular; refusing the whole \
                             collation (nothing instanced, every drawable mesh drawn flat)"
                        );
                    }
                );
                return all_drawable_flat(meshes);
            }
        },
    };
    // First-seen order keeps output deterministic regardless of hash iteration.
    let mut order: Vec<u128> = Vec::new();
    let mut groups: FxHashMap<u128, Vec<usize>> = FxHashMap::default();
    // Non-instanceable meshes (void-cut walls, multi-item merges, site-rotated
    // elements — anything carrying no usable InstanceMeta) still must be DRAWN, so
    // they're routed to flat_indices and emitted as flat singleton templates.
    // Dropping them here would silently lose geometry now that capture is always-on
    // and real models feed the collator — the unit fixtures were all instanceable,
    // which hid this. A non-empty non-instanceable mesh goes flat; an EMPTY mesh
    // carries nothing to draw UNLESS it is a #1623 Phase 3 don't-bake occurrence
    // placeholder (empty geometry + instanceable InstanceMeta) — the shared template
    // supplies its geometry, so it joins its rep group like a materialized member.
    let mut flat: Vec<usize> = Vec::new();
    for (i, m) in meshes.iter().enumerate() {
        match m.instance_meta {
            Some(im) if im.instanceable => {
                groups
                    .entry(im.rep_identity)
                    .or_insert_with(|| {
                        order.push(im.rep_identity);
                        Vec::new()
                    })
                    .push(i);
            }
            // Empty + non-instanceable = nothing to draw (skip); non-empty +
            // non-instanceable = flat singleton.
            _ if !m.positions.is_empty() => flat.push(i),
            _ => {}
        }
    }

    // Route only DRAWABLE members flat: an empty don't-bake placeholder carries no
    // geometry, so it can never render flat — the caller (the wasm don't-bake
    // finalize) recovers such occurrences flat itself before collation, so a group
    // it feeds here always has a materialized template and passes the count gate.
    // Filtering defends against ever silently emitting an empty flat singleton.
    let drawable = |members: &[usize]| -> Vec<usize> {
        members
            .iter()
            .copied()
            .filter(|&i| !meshes[i].positions.is_empty())
            .collect::<Vec<_>>()
    };

    let mut out = Collated {
        flat_indices: flat,
        ..Collated::default()
    };
    for rep in order {
        let members = &groups[&rep];
        if members.len() < min_group.max(1) {
            out.flat_indices.extend(drawable(members));
            continue;
        }
        // Template = the first NON-EMPTY (materialized) member. Empty members are
        // don't-bake placeholders whose geometry IS this template.
        let Some(t_idx) = members
            .iter()
            .copied()
            .find(|&i| !meshes[i].positions.is_empty())
        else {
            // All-empty group: no template geometry to draw against. Unreachable by
            // the caller contract (a materialized template always accompanies its
            // occurrences); drop rather than emit empty singletons that draw nothing.
            continue;
        };
        let template = &meshes[t_idx];
        // Compose in the post-RTC frame so the georeferenced offset cancels
        // exactly regardless of each occurrence's rotation (see fn docs).
        let m_ref = to_post_rtc(compose_world(template.instance_meta.unwrap()), rtc);
        let Some(m_ref_inv) = m_ref.try_inverse() else {
            out.flat_indices.extend(drawable(members));
            continue;
        };

        // Rigidity is a PER-MEMBER property, not a group-level one: a
        // rep_identity group can legitimately mix a rigid-tier member
        // (rotation-normalized, congruent but NOT bit-identical — the
        // renderer substitutes the template's geometry at its pose, so
        // rel_k is pose-only) alongside exact-tier members that ARE
        // bit-identical to the template. Gating the count check / pairing
        // verification on whether ANY member of the group is rigid would
        // skip both for every non-rigid member too, just because one
        // sibling happens to be rigid — check each member's own
        // `canonical_transform` instead.
        let vlen = template.positions.len();
        let mut occurrences = Vec::with_capacity(members.len());
        let mut shapes_match = true;
        for &i in members {
            let mesh = &meshes[i];
            let member_is_rigid = mesh
                .instance_meta
                .and_then(|m| m.canonical_transform)
                .is_some();
            // A #1623 Phase 3 don't-bake placeholder (empty geometry) is pose-only:
            // its geometry IS the template, so skip the same-shape guard (like the
            // rigid tier). Exact-tier materialized occurrences share the SAME local
            // geometry, differing only by placement — their BAKED positions
            // legitimately differ (verified below against `rel` instead), but their
            // TOPOLOGY does not: baking transforms positions and never rewrites the
            // index buffer, so a genuine group's indices are byte-identical. Compare
            // them outright, not just their length — identical positions under a
            // different connectivity would be handed the template's topology.
            let pose_only = mesh.positions.is_empty();
            if !pose_only
                && !member_is_rigid
                && (mesh.positions.len() != vlen || mesh.indices != template.indices)
            {
                shapes_match = false;
                break;
            }
            let m_k = to_post_rtc(compose_world(mesh.instance_meta.unwrap()), rtc);
            let rel = m_k * m_ref_inv;
            // #3666: a shared `rep_identity` is not proof of shared geometry —
            // a 128-bit direct-geometry hash collision has been measured on a
            // real merged model. The count check above still lets a same-
            // shaped colliding pair through, so reconstruct this occurrence
            // from (template, rel) and verify it against its OWN baked
            // vertices before trusting the pairing. Scoped to the exact tier
            // (rigid-tier members can legitimately carry a different raw
            // vertex count than the template by design — see module docs).
            //
            // Skip the template's own iteration (`i == t_idx`): `m_k` is
            // `compose_world` of the SAME `instance_meta` that produced
            // `m_ref`, so `rel = m_ref * m_ref_inv` is the template
            // reconstructing itself under (its own) identity — a check that
            // is trivially true by construction, not a guard against
            // anything. Every other member still verifies against the
            // template as before.
            if !pose_only && !member_is_rigid && i != t_idx {
                let verify_rel =
                    verify_conjugate.as_ref().map_or(rel, |(s, s_inv)| s * rel * s_inv);
                if !verify_pairing(
                    template.origin,
                    template.positions,
                    mesh.origin,
                    mesh.positions,
                    &verify_rel,
                ) {
                    shapes_match = false;
                    break;
                }
            }
            occurrences.push(InstanceOccurrence {
                mesh_index: i,
                transform: mat4_to_row_major_f32(&rel),
            });
        }

        if shapes_match {
            out.templates.push(InstanceTemplate {
                rep_identity: rep,
                template_index: t_idx,
                occurrences,
            });
            continue;
        }

        // The group is not trustworthy, so no MATERIALIZED member is instanced —
        // each draws itself, flat. But a #1623 Phase 3 don't-bake placeholder
        // (empty geometry, placement only) has nothing of its own to draw: the
        // template IS its geometry. Routing the whole group through `drawable`
        // dropped those placeholders entirely — neither instanced nor drawn, the
        // occurrence gone from the output with nothing reporting it.
        //
        // A placeholder is also not what failed: with no baked vertices it can
        // never be verified in either direction, and the template is the only
        // geometry it could ever be drawn with (before this check existed, that
        // is exactly what it got). So keep the template and its placeholders
        // instanced, and flatten only the members that can stand alone.
        let pose_only: Vec<usize> = members
            .iter()
            .copied()
            .filter(|&i| meshes[i].positions.is_empty())
            .collect();
        if pose_only.is_empty() {
            out.flat_indices.extend(drawable(members));
            continue;
        }
        // The template rides along as its own occurrence (identity `rel`, exactly
        // as on the success path) rather than going flat, so its geometry is
        // uploaded once and drawn once.
        let kept: Vec<InstanceOccurrence> = std::iter::once(t_idx)
            .chain(pose_only)
            .map(|i| InstanceOccurrence {
                mesh_index: i,
                transform: mat4_to_row_major_f32(
                    &(to_post_rtc(compose_world(meshes[i].instance_meta.unwrap()), rtc)
                        * m_ref_inv),
                ),
            })
            .collect();
        out.templates.push(InstanceTemplate {
            rep_identity: rep,
            template_index: t_idx,
            occurrences: kept,
        });
        out.flat_indices
            .extend(drawable(members).into_iter().filter(|&i| i != t_idx));
    }
    out
}

// The #1623 Phase 2 don't-bake finalize helpers (`compose_instance_world_row_major`,
// `instance_rel_row_major_f32`, `bake_source_at_world`) moved to `super::dont_bake`
// (kept re-exported below) — the module-size ratchet budget pushed them out once
// the per-member rigidity fix and its diagnostics landed here.
pub use super::dont_bake::{
    bake_source_at_world, compose_instance_world_row_major, instance_rel_row_major_f32,
};

/// `collate_refs` over geometry `Mesh` values (thin wrapper, no geometry clone).
pub fn collate_instances(meshes: &[Mesh], min_group: usize, rtc: [f64; 3]) -> Collated {
    let refs: Vec<InstanceMeshRef> = meshes.iter().map(InstanceMeshRef::from_mesh).collect();
    collate_refs(&refs, min_group, rtc)
}

// verify_recomposition moved to super::verify (kept as a re-export below) —
// the module-size ratchet budget pushed it out once #3666's inline pairing
// check landed here; it belongs next to that check's shared math anyway.
pub use super::verify::verify_recomposition;

/// Every mesh that carries geometry, rendered flat: the whole-input fallback when
/// collation is refused before any group is examined. Empty (pose-only) members
/// are omitted because they have nothing to draw on their own; they exist only as
/// occurrences of a template, and this result has none.
fn all_drawable_flat(meshes: &[InstanceMeshRef]) -> Collated {
    Collated {
        flat_indices: (0..meshes.len())
            .filter(|&i| !meshes[i].positions.is_empty())
            .collect(),
        ..Collated::default()
    }
}
