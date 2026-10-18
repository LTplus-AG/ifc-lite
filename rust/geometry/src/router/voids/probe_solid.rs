// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Full planar-profile source eligibility and native sweep frames.

use super::{checked_probe, ExtrudedSolidInfo, GeometryRouter, MAX_EXTRUSION_EXTRACT_DEPTH};
use crate::profiles::ProfileProcessor;
use crate::Result;
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
use rustc_hash::FxHashSet;

impl GeometryRouter {
    /// Unwrap `item` — through `IfcMappedItem` (accumulating the mapping
    /// transform), but NOT through `IfcBooleanClippingResult`/`IfcBooleanResult`
    /// (a clipped host is ineligible for the 2D re-extrude) — to a single
    /// `IfcExtrudedAreaSolid` swept along its profile normal (local ±Z), and
    /// recover its full 2D profile + depth + composed profile-local→native-world
    /// transform. Returns `None` for any non-extrusion, clipped, obliquely-swept,
    /// or degenerate solid, so callers fall back to the exact kernel.
    pub(super) fn extruded_solid_from_item(
        &self,
        item: DecodedEntity,
        placement: &Matrix4<f64>,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<ExtrudedSolidInfo>> {
        checked_probe(|terminal| {
            let mut current = item;
            let mut chain = Matrix4::<f64>::identity();
            let mut visited = FxHashSet::default();
            let solid = loop {
                if !visited.insert(current.id) || visited.len() > MAX_EXTRUSION_EXTRACT_DEPTH {
                    return None;
                }
                match current.ifc_type {
                    IfcType::IfcExtrudedAreaSolid => break current,
                    IfcType::IfcMappedItem => {
                        let source =
                            probe_result!(terminal, decoder.resolve_ref(current.get(0)?))??;
                        let mapped_rep =
                            probe_result!(terminal, decoder.resolve_ref(source.get(1)?))??;
                        // MappingTarget · MappingOrigin, matching the mesh path
                        // (#1985). The composition MUST parse: silently dropping it
                        // would misplace the re-extruded footprint, so any failure
                        // defers the whole opening to the exact kernel rather than
                        // continuing with an identity transform.
                        if let Some(mm) = probe_result!(
                            terminal,
                            self.mapped_item_transform(&current, &source, decoder)
                        )? {
                            chain *= mm;
                        }
                        // Require EXACTLY ONE mapped representation item. A multi-item
                        // mapped opening would otherwise be reduced to its first
                        // solid, dropping the rest from BOTH the 2D footprint and the
                        // residual exact cut; defer the whole opening instead.
                        let mut items =
                            probe_result!(terminal, decoder.resolve_ref_list(mapped_rep.get(3)?))?
                                .into_iter();
                        let first = items.next()?;
                        if items.next().is_some() {
                            return None;
                        }
                        current = first;
                    }
                    // Boolean clipping / anything else: ineligible for the 2D path.
                    _ => return None,
                }
            };

            let profile_entity = probe_result!(terminal, decoder.resolve_ref(solid.get(0)?))??;
            // The 2D path re-extrudes ONE outer ring with holes; a composite of
            // several disjoint areas (#7685) defers to the 3D path.
            let [profile] = <[_; 1]>::try_from(probe_result!(
                terminal,
                ProfileProcessor::new(self.schema.clone()).process_regions(
                    &profile_entity,
                    decoder,
                    self.tessellation_quality
                )
            )?)
            .ok()?;
            if profile.outer.len() < 3 {
                return None;
            }
            let depth = solid.get_float(3)?;
            if !depth.is_finite() || depth <= 0.0 {
                return None;
            }
            let dir_local = {
                let e = probe_result!(terminal, decoder.resolve_ref(solid.get(2)?))??;
                probe_result!(terminal, self.parse_direction(&e))?
            }
            .try_normalize(1e-12)?;
            // The 2D re-extrude is only valid when the sweep is along the profile
            // normal (local ±Z). An oblique / sheared extrusion shifts the footprint
            // with depth, so the through-cut projection would be wrong — defer.
            if dir_local.x.abs() > 1e-6 || dir_local.y.abs() > 1e-6 {
                return None;
            }
            let dir_sign = if dir_local.z >= 0.0 { 1.0 } else { -1.0 };
            let solid_pos = match solid.get(1) {
                Some(a) if !a.is_null() => {
                    let e = probe_result!(terminal, decoder.resolve_ref(a))??;
                    probe_result!(terminal, self.parse_axis2_placement_3d(&e, decoder))?
                }
                _ => Matrix4::identity(),
            };
            Some(ExtrudedSolidInfo {
                profile,
                depth,
                dir_sign,
                m: placement * chain * solid_pos,
            })
        })
    }

    /// The host element's body as a SINGLE eligible extruded solid (exactly one
    /// Body item, an `IfcExtrudedAreaSolid` after unwrapping mapped items). A
    /// multi-item body or a clipped host returns `None`.
    pub(crate) fn host_extruded_solid_checked(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<ExtrudedSolidInfo>> {
        checked_probe(|terminal| {
            let placement = probe_result!(
                terminal,
                self.get_placement_transform_from_element(element, decoder)
            )?;
            let items = probe_result!(terminal, self.body_representation_items(element, decoder))??;
            if items.len() != 1 {
                return None;
            }
            probe_result!(
                terminal,
                self.extruded_solid_from_item(items.into_iter().next()?, &placement, decoder)
            )?
        })
    }

    /// Every Body item of an opening element as an eligible extruded solid (an
    /// opening may be a union of extruded prisms — Tekla multi-solid). `None` if
    /// the body is empty or ANY item is not a clean extruded solid.
    pub(crate) fn opening_extruded_solids_checked(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Vec<ExtrudedSolidInfo>>> {
        checked_probe(|terminal| {
            let placement = probe_result!(
                terminal,
                self.get_placement_transform_from_element(element, decoder)
            )?;
            let items = probe_result!(terminal, self.body_representation_items(element, decoder))??;
            if items.is_empty() {
                return None;
            }
            let mut out = Vec::with_capacity(items.len());
            for it in items {
                out.push(probe_result!(
                    terminal,
                    self.extruded_solid_from_item(it, &placement, decoder)
                )??);
            }
            Some(out)
        })
    }
}
