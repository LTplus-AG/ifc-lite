// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The rep-identity grouping pass, split out of `collate.rs` so that file stays
//! within its module-size budget: `collate.rs` owns the collation TYPES and the
//! small frame helpers, this file owns the pass that walks the groups, verifies
//! each candidate pairing (#3666) and decides what falls back to the flat path.

use super::collate::{
    compose_world, mat4_to_row_major_f32, to_post_rtc, Collated, InstanceMeshRef,
    InstanceOccurrence, InstanceTemplate,
};
use super::verify::verify_pairing;
use nalgebra::Matrix4;
use rustc_hash::FxHashMap;

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

    let mut out = Collated {
        flat_indices: flat,
        ..Collated::default()
    };
    for rep in order {
        let members = &groups[&rep];
        // Template = the first NON-EMPTY (materialized) member. Empty members are
        // don't-bake placeholders whose geometry IS this template.
        let Some(t_idx) = members
            .iter()
            .copied()
            .find(|&i| !meshes[i].positions.is_empty())
        else {
            // All-empty group: no template geometry to draw against. Unreachable by
            // the caller contract (a materialized template always accompanies its
            // occurrences); there is nothing to emit, so report the loss instead of
            // emitting empty singletons that draw nothing.
            out.dropped_placeholders += members.len();
            continue;
        };
        let template = &meshes[t_idx];
        // Compose in the post-RTC frame so the georeferenced offset cancels
        // exactly regardless of each occurrence's rotation (see fn docs).
        let m_ref = to_post_rtc(compose_world(template.instance_meta.unwrap()), rtc);
        // Computed BEFORE the threshold check: every refusal below needs it to
        // place the group's pose-only placeholders (see `fall_back`).
        let m_ref_inv = m_ref.try_inverse();

        // The template is the geometry EVERY occurrence in this group will be
        // drawn with, and it is the one member nothing checks: it pairs with
        // itself trivially (the `i == t_idx` short-circuit below), while
        // pose-only and rigid members are exempt by design. So a group of a
        // non-finite template plus placeholders had no member the reconstruction
        // check ever looked at, and substituted the NaN geometry once per
        // occurrence. Check it once, here, and refuse the group — with `None`,
        // because placing anything against untrustworthy geometry is the thing
        // being prevented.
        if !template.positions.iter().all(|p| p.is_finite()) {
            out.verification_rejections += 1;
            fall_back(&mut out, meshes, rep, members, t_idx, None, rtc);
            continue;
        }
        if members.len() < min_group.max(1) {
            fall_back(&mut out, meshes, rep, members, t_idx, m_ref_inv.as_ref(), rtc);
            continue;
        }
        let Some(m_ref_inv) = m_ref_inv else {
            // A singular template placement is the one refusal that genuinely
            // cannot place a placeholder: there is no `rel` to compute for
            // anyone. `fall_back` counts what it has to drop.
            fall_back(&mut out, meshes, rep, members, t_idx, None, rtc);
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
            if i == t_idx {
                // The template against itself: the shape check compares it with
                // its own buffers and `rel` is the identity, so both checks are
                // tautologies. Emit the identity occurrence without walking the
                // template's vertices a second time.
                occurrences.push(InstanceOccurrence {
                    mesh_index: i,
                    transform: mat4_to_row_major_f32(&(m_ref * m_ref_inv)),
                });
                continue;
            }
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

        out.verification_rejections += 1;
        fall_back(&mut out, meshes, rep, members, t_idx, Some(&m_ref_inv), rtc);
    }
    out
}

/// What a group that will NOT be instanced as a whole leaves behind.
///
/// Every materialized member draws itself, flat. But a #1623 Phase 3 don't-bake
/// placeholder (empty geometry, placement only) has nothing of its own to draw:
/// the template IS its geometry. Routing the whole group flat dropped those
/// placeholders entirely — neither instanced nor drawn, the occurrence gone from
/// the output with nothing reporting it.
///
/// A placeholder is also never the member that failed: with no baked vertices it
/// can never be verified in either direction, and the template is the only
/// geometry it could ever be drawn with (before the #3666 check existed, that is
/// exactly what it got). So when `place_with` (the template's inverse placement)
/// exists, the template and its placeholders stay instanced and only the
/// stand-alone members are flattened. When it does not, nothing can be placed,
/// and the placeholders are counted rather than quietly discarded.
fn fall_back(
    out: &mut Collated,
    meshes: &[InstanceMeshRef],
    rep: u128,
    members: &[usize],
    t_idx: usize,
    place_with: Option<&Matrix4<f64>>,
    rtc: [f64; 3],
) {
    let pose_only: Vec<usize> = members
        .iter()
        .copied()
        .filter(|&i| meshes[i].positions.is_empty())
        .collect();
    let materialized = || members.iter().copied().filter(|&i| !meshes[i].positions.is_empty());
    let Some(m_ref_inv) = place_with.filter(|_| !pose_only.is_empty()) else {
        out.dropped_placeholders += pose_only.len();
        out.flat_indices.extend(materialized());
        return;
    };
    // The template rides along as its own occurrence (identity `rel`, exactly as
    // on the success path) rather than going flat, so its geometry is uploaded
    // once and drawn once.
    let kept: Vec<InstanceOccurrence> = std::iter::once(t_idx)
        .chain(pose_only)
        .map(|i| InstanceOccurrence {
            mesh_index: i,
            transform: mat4_to_row_major_f32(
                &(to_post_rtc(compose_world(meshes[i].instance_meta.unwrap()), rtc) * m_ref_inv),
            ),
        })
        .collect();
    out.templates.push(InstanceTemplate {
        rep_identity: rep,
        template_index: t_idx,
        occurrences: kept,
    });
    out.flat_indices.extend(materialized().filter(|&i| i != t_idx));
}

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
