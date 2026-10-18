// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! IFC parametric decode + cutter-mesh extraction from opening elements.

use super::{GeometryRouter, RectParam, MAX_EXTRUSION_EXTRACT_DEPTH};
use crate::profile::Profile2D;
use crate::{Mesh, Point3, Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::Matrix4;
use rustc_hash::FxHashSet;

/// A host or opening solid recovered as a single IfcExtrudedAreaSolid swept along
/// its profile normal (local ±Z), for the 2D opening-subtraction fast path
/// ([`super::bool2d_path`]). `m` maps profile-local coordinates (profile in the
/// z=0 plane, swept to `dir_sign·depth`) to NATIVE world (pre unit-scale / RTC),
/// composed as `placement · mapped-chain · solid-Position`.
pub(crate) struct ExtrudedSolidInfo {
    /// Full 2D profile (outer + any holes) in the solid's profile plane.
    pub profile: Profile2D,
    /// Extrusion depth (> 0).
    pub depth: f64,
    /// +1 for a +Z sweep, -1 for a -Z sweep (the only two eligible cases).
    pub dir_sign: f64,
    /// Profile-local → native-world transform.
    pub m: Matrix4<f64>,
}

// An eligibility miss is separate from a terminal source/resource outcome.
// Keep the Option walk's original early-return policies while carrying typed
// stops even for direct callers with no ambient account or source scope.
macro_rules! probe_result {
    ($terminal:expr, $operation:expr) => {{
        if let Err(error) = crate::resource::check_current() {
            *$terminal = Some(error.into());
            return None;
        }
        match crate::resource::observe($operation.map_err(crate::Error::from)) {
            Err(error @ crate::Error::ProgramStopped(_)) => {
                *$terminal = Some(error);
                return None;
            }
            result => result.ok(),
        }
    }};
}

fn checked_probe<T>(
    operation: impl FnOnce(&mut Option<crate::Error>) -> Option<T>,
) -> Result<Option<T>> {
    crate::resource::check_current()?;
    let mut terminal = None;
    let value = operation(&mut terminal);
    if let Some(error) = terminal {
        return Err(error);
    }
    crate::resource::check_current()?;
    Ok(value)
}

#[path = "probe_rectangle.rs"]
mod rectangle;
#[path = "probe_solid.rs"]
mod solid;

impl GeometryRouter {
    pub fn parametric_rect_probe_all(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<Vec<RectParam>> {
        self.parametric_rect_probe_all_checked(element, decoder)
            .ok()
            .flatten()
    }

    pub fn parametric_rect_probe(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<RectParam> {
        self.parametric_rect_probe_checked(element, decoder)
            .ok()
            .flatten()
    }

    #[cfg(test)]
    fn read_rect_profile_2d(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Option<(f64, f64, f64, f64, f64, f64)> {
        self.read_rect_profile_2d_checked(profile, decoder)
            .ok()
            .flatten()
    }

    // Get individual bounding boxes for each representation item in an opening element.
    // This handles disconnected geometry (e.g., two separate window openings in one IfcOpeningElement)
    // by returning separate bounds for each item instead of one combined bounding box.

    /// Extract extrusion direction and position transform from IfcExtrudedAreaSolid
    /// Returns (local_direction, position_transform)
    fn extract_extrusion_direction_from_solid(
        &self,
        solid: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<(Vector3<f64>, Option<Matrix4<f64>>)>> {
        checked_probe(|terminal| {
            // Get ExtrudedDirection (attribute 2: IfcDirection)
            let direction_attr = solid.get(2)?;
            let direction_entity = probe_result!(terminal, decoder.resolve_ref(direction_attr))??;
            let local_dir = probe_result!(terminal, self.parse_direction(&direction_entity))?;

            // Get Position transform (attribute 1: IfcAxis2Placement3D)
            let position_transform = if let Some(pos_attr) = solid.get(1) {
                if !pos_attr.is_null() {
                    if let Some(Some(pos_entity)) =
                        probe_result!(terminal, decoder.resolve_ref(pos_attr))
                    {
                        if pos_entity.ifc_type == IfcType::IfcAxis2Placement3D {
                            probe_result!(
                                terminal,
                                self.parse_axis2_placement_3d(&pos_entity, decoder)
                            )
                        } else {
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                }
            } else {
                None
            };

            Some((local_dir, position_transform))
        })
    }

    /// Recursively extract extrusion direction and position transform from representation item
    /// Handles IfcExtrudedAreaSolid, IfcBooleanClippingResult, and IfcMappedItem
    /// Returns (local_direction, position_transform) where direction is in local space
    pub(crate) fn extract_extrusion_direction_recursive_checked(
        &self,
        item: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<(Vector3<f64>, Option<Matrix4<f64>>)>> {
        checked_probe(|terminal| {
            let mut current = item.clone();
            let mut visited = FxHashSet::default();
            let mut mapping_chain: Option<Matrix4<f64>> = None;

            for _depth in 0..MAX_EXTRUSION_EXTRACT_DEPTH {
                if !visited.insert(current.id) {
                    return None;
                }

                match current.ifc_type {
                    IfcType::IfcExtrudedAreaSolid => {
                        let (dir, position_transform) = probe_result!(
                            terminal,
                            self.extract_extrusion_direction_from_solid(&current, decoder)
                        )??;
                        let combined = match (mapping_chain.as_ref(), position_transform) {
                            (Some(chain), Some(pos)) => Some(chain * pos),
                            (Some(chain), None) => Some(*chain),
                            (None, Some(pos)) => Some(pos),
                            (None, None) => None,
                        };
                        return Some((dir, combined));
                    }
                    IfcType::IfcBooleanClippingResult | IfcType::IfcBooleanResult => {
                        // FirstOperand (attribute 1) contains base geometry
                        let first_attr = current.get(1)?;
                        current = probe_result!(terminal, decoder.resolve_ref(first_attr))??;
                    }
                    IfcType::IfcMappedItem => {
                        // MappingSource (attribute 0) -> MappedRepresentation -> Items
                        let source_attr = current.get(0)?;
                        let source = probe_result!(terminal, decoder.resolve_ref(source_attr))??;
                        // RepresentationMap.MappedRepresentation is attribute 1
                        let rep_attr = source.get(1)?;
                        let rep = probe_result!(terminal, decoder.resolve_ref(rep_attr))??;

                        // MappingTarget · MappingOrigin -> instance transform (#1985).
                        // A composition that fails to parse abandons the probe (the
                        // caller falls back to the exact kernel) rather than reporting
                        // an extrusion direction resolved in the wrong frame.
                        if let Some(map) = probe_result!(
                            terminal,
                            self.mapped_item_transform(&current, &source, decoder)
                        )? {
                            mapping_chain = Some(match mapping_chain.take() {
                                Some(chain) => chain * map,
                                None => map,
                            });
                        }

                        // Get first item from representation
                        let items_attr = rep.get(3)?;
                        let items = probe_result!(terminal, decoder.resolve_ref_list(items_attr))?;
                        current = items.first()?.clone();
                    }
                    _ => return None,
                }
            }

            None
        })
    }

    /// Items of the element's body shape representation(s), selected EXACTLY as
    /// the main mesh path (`process_element` /
    /// `process_element_with_submeshes_impl`): the effective representation type
    /// (`RepresentationType`, falling back to the `RepresentationIdentifier`
    /// when blank — CATIA #1661) filtered by [`crate::router::is_body_representation`], with a
    /// `MappedRepresentation` skipped when the element also carries direct body
    /// geometry (the mesh path's de-dup, so the fast path reads the same solids
    /// the renderer draws). Items from EVERY qualifying representation are
    /// collected — the mesh path merges them all — so a probe that requires a
    /// single item correctly DEFERS when the rendered body spans more than one
    /// representation instead of silently cutting only the first. The old raw
    /// `RepresentationType`-only match could latch onto an earlier auxiliary
    /// `SweptSolid`/`SolidModel` (or miss a CATIA blank-type/`Body`-identifier
    /// rep the renderer meshes), driving the cut off a DIFFERENT solid than the
    /// one rendered.
    fn body_representation_items(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Vec<DecodedEntity>>> {
        checked_probe(|terminal| {
            let rep = probe_result!(terminal, decoder.resolve_ref(element.get(6)?))??;
            if rep.ifc_type != IfcType::IfcProductDefinitionShape {
                return None;
            }
            let reps = probe_result!(terminal, decoder.resolve_ref_list(rep.get(2)?))?;
            // Mirror the mesh path's direct-vs-mapped de-dup: a MappedRepresentation
            // is skipped only when the element ALSO carries direct body geometry.
            let has_direct_geometry = reps.iter().any(|sr| {
                sr.ifc_type == IfcType::IfcShapeRepresentation
                    && crate::router::effective_element_rep_type(element, sr)
                        .map(crate::router::is_direct_body_representation)
                        .unwrap_or(false)
            });
            let mut items = Vec::new();
            for sr in reps {
                if sr.ifc_type != IfcType::IfcShapeRepresentation {
                    continue;
                }
                let Some(rt) = crate::router::effective_element_rep_type(element, &sr) else {
                    continue;
                };
                if rt == "MappedRepresentation" && has_direct_geometry {
                    continue;
                }
                if !crate::router::is_body_representation(rt) {
                    continue;
                }
                let Some(items_attr) = sr.get(3) else {
                    continue;
                };
                if let Some(rep_items) =
                    probe_result!(terminal, decoder.resolve_ref_list(items_attr))
                {
                    items.extend(rep_items);
                }
            }
            if items.is_empty() {
                None
            } else {
                Some(items)
            }
        })
    }

    /// EXACT boxes for a body that is a UNION OF RECTANGULAR PRISMS (the common Tekla
    /// multi-solid opening): one box per representation item, or `None` if any item is not a
    /// rectangular extrusion. The cellular `rect_fast` cut subtracts the N boxes natively.
    pub(crate) fn parametric_rect_probe_all_checked(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<Vec<RectParam>>> {
        checked_probe(|terminal| {
            let placement = probe_result!(
                terminal,
                self.get_placement_transform_from_element(element, decoder)
            )?;
            let items = probe_result!(terminal, self.body_representation_items(element, decoder))??;
            if items.is_empty() {
                return None;
            }
            let mut boxes = Vec::with_capacity(items.len());
            for item in items {
                boxes.push(probe_result!(
                    terminal,
                    self.rect_param_from_item(item, &placement, decoder)
                )??);
            }
            Some(boxes)
        })
    }

    /// PHASE-0 CENSUS (read-only): the EXACT oriented rectangular box of an extruded
    /// element, read from the IFC parametrics (IfcRectangleProfileDef XDim/YDim/Depth +
    /// composed placement axes), NOT inferred from the f32 mesh. Returns `None` unless the
    /// element's body is a single clean IfcRectangleProfileDef extrusion (after unwrapping
    /// IfcBooleanClippingResult / IfcMappedItem). This is the parametric frame + extents the
    /// failed oriented attempt should have used instead of `infer_opening_frame` + mesh-AABB.
    pub(crate) fn parametric_rect_probe_checked(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<RectParam>> {
        checked_probe(|terminal| {
            let placement = probe_result!(
                terminal,
                self.get_placement_transform_from_element(element, decoder)
            )?;
            // A clean rectangular extrusion is exactly ONE Body item. A multi-solid
            // body (the probe would otherwise read only the first) must defer so the
            // exact kernel cuts all of it. Sharing `body_representation_items` +
            // `rect_param_from_item` with `parametric_rect_probe_all` keeps the host
            // frame and the cutter frames on ONE derivation - they cannot drift into
            // a silent miscut (they feed the same shared-frame cellular cut).
            let items = probe_result!(terminal, self.body_representation_items(element, decoder))??;
            if items.len() != 1 {
                return None;
            }
            probe_result!(
                terminal,
                self.rect_param_from_item(items.into_iter().next()?, &placement, decoder)
            )?
        })
    }

    /// Get per-item meshes for an opening element, transformed to world coordinates.
    /// Uses the same `transform_mesh` path as `process_element` to ensure identical
    /// coordinate handling (ObjectPlacement, unit scaling, conditional RTC offset).
    pub fn get_opening_item_meshes_world(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<Mesh>> {
        let Some(program) = crate::program::opening::OpeningProgram::admit(
            element,
            crate::program::EntryPolicy::OpeningItemMeshes,
            self,
            decoder,
        )?
        else {
            return Ok(vec![]);
        };
        program.meshes(element, self, decoder)
    }

    /// Extrusion direction is in world coordinates, normalized
    /// Returns None for extrusion direction if it cannot be extracted (fallback to bounds-only)
    pub fn get_opening_item_bounds_with_direction(
        &self,
        element: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Vec<(Point3<f64>, Point3<f64>, Option<Vector3<f64>>)>> {
        let Some(program) = crate::program::opening::OpeningProgram::admit(
            element,
            crate::program::EntryPolicy::OpeningItemBounds,
            self,
            decoder,
        )?
        else {
            return Ok(vec![]);
        };
        program.bounds(self, decoder)
    }
}

#[cfg(test)]
#[path = "probe_tests.rs"]
mod tests;
