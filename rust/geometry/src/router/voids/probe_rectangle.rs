// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Rectangular-profile source eligibility and exact authored frames.

use super::{checked_probe, GeometryRouter, Point3, RectParam, MAX_EXTRUSION_EXTRACT_DEPTH};
use crate::{Result, Vector3};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcType};
use nalgebra::{Matrix3, Matrix4};
use rustc_hash::FxHashSet;

impl GeometryRouter {
    /// Read a rectangular swept area as `(x_dim, y_dim, off_x, off_y, cos, sin)` in the
    /// profile plane. Handles `IfcRectangleProfileDef` (XDim/YDim + 2D Position rotation)
    /// AND an `IfcArbitraryClosedProfileDef` whose outer curve is an axis-aligned 4-point
    /// rectangle polyline (the common Tekla/structural authoring of a rectangular wall).
    /// `None` for any non-rectangular profile → the caller defers to the exact kernel.
    pub(super) fn read_rect_profile_2d_checked(
        &self,
        profile: &DecodedEntity,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<(f64, f64, f64, f64, f64, f64)>> {
        checked_probe(|terminal| {
            match profile.ifc_type {
                IfcType::IfcRectangleProfileDef => {
                    let x_dim = profile.get_float(3)?;
                    let y_dim = profile.get_float(4)?;
                    // Position (attr 2 = IfcAxis2Placement2D): in-plane rotation + offset.
                    let (mut cos_t, mut sin_t, mut off_x, mut off_y) = (1.0, 0.0, 0.0, 0.0);
                    if let Some(pos_attr) = profile.get(2) {
                        if !pos_attr.is_null() {
                            if let Some(Some(pos)) =
                                probe_result!(terminal, decoder.resolve_ref(pos_attr))
                            {
                                if let Some(loc_attr) = pos.get(0) {
                                    if let Some(Some(loc)) =
                                        probe_result!(terminal, decoder.resolve_ref(loc_attr))
                                    {
                                        if let Some(c) = loc.get(0).and_then(|x| x.as_list()) {
                                            off_x =
                                                c.first().and_then(|x| x.as_float()).unwrap_or(0.0);
                                            off_y =
                                                c.get(1).and_then(|x| x.as_float()).unwrap_or(0.0);
                                        }
                                    }
                                }
                                if let Some(rd_attr) = pos.get(1) {
                                    if !rd_attr.is_null() {
                                        if let Some(Some(rd)) =
                                            probe_result!(terminal, decoder.resolve_ref(rd_attr))
                                        {
                                            if let Some(c) = rd.get(0).and_then(|x| x.as_list()) {
                                                let dx = c
                                                    .first()
                                                    .and_then(|x| x.as_float())
                                                    .unwrap_or(1.0);
                                                let dy = c
                                                    .get(1)
                                                    .and_then(|x| x.as_float())
                                                    .unwrap_or(0.0);
                                                let n = (dx * dx + dy * dy).sqrt();
                                                if n > 1e-12 {
                                                    cos_t = dx / n;
                                                    sin_t = dy / n;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Some((x_dim, y_dim, off_x, off_y, cos_t, sin_t))
                }
                IfcType::IfcArbitraryClosedProfileDef => {
                    // OuterCurve (attr 2) must be an axis-aligned rectangle polyline.
                    let curve = probe_result!(terminal, decoder.resolve_ref(profile.get(2)?))??;
                    if curve.ifc_type != IfcType::IfcPolyline {
                        return None;
                    }
                    let pts = probe_result!(terminal, decoder.resolve_ref_list(curve.get(0)?))?;
                    let mut coords: Vec<(f64, f64)> = Vec::with_capacity(pts.len());
                    for p in &pts {
                        let c = p.get(0).and_then(|x| x.as_list())?;
                        coords.push((c.first()?.as_float()?, c.get(1)?.as_float()?));
                    }
                    // Drop a repeated closing vertex.
                    if coords.len() >= 2 {
                        let (f, l) = (coords[0], coords[coords.len() - 1]);
                        if (f.0 - l.0).abs() < 1e-9 && (f.1 - l.1).abs() < 1e-9 {
                            coords.pop();
                        }
                    }
                    if coords.len() != 4 {
                        return None;
                    }
                    // General 4-point RECTANGLE — axis-aligned OR rotated in-plane. Compute the
                    // oriented box from its edges and fold the in-plane rotation into the frame
                    // (`cos_t`/`sin_t`). Tekla / IFC2X3 routinely author rotated-rectangle
                    // openings this way, so the old axis-aligned-only check rejected ~90% of
                    // them. Axis-aligned is just the cos_t=1, sin_t=0 special case.
                    let p = &coords;
                    let edge = |i: usize| (p[(i + 1) % 4].0 - p[i].0, p[(i + 1) % 4].1 - p[i].1);
                    let len = |e: (f64, f64)| (e.0 * e.0 + e.1 * e.1).sqrt();
                    let e0 = edge(0);
                    let e1 = edge(1);
                    let e2 = edge(2);
                    let (xd, yd) = (len(e0), len(e1));
                    if xd <= 1e-9 || yd <= 1e-9 {
                        return None;
                    }
                    // Rectangle: adjacent edges perpendicular AND opposite edges equal length.
                    let dot = (e0.0 * e1.0 + e0.1 * e1.1) / (xd * yd);
                    if dot.abs() > 0.01 || (len(e2) - xd).abs() > xd * 0.01 + 1e-6 {
                        return None;
                    }
                    // Local X' = first-edge direction; centre = polygon centroid.
                    let (cos_t, sin_t) = (e0.0 / xd, e0.1 / xd);
                    let cx = (p[0].0 + p[1].0 + p[2].0 + p[3].0) * 0.25;
                    let cy = (p[0].1 + p[1].1 + p[2].1 + p[3].1) * 0.25;
                    Some((xd, yd, cx, cy, cos_t, sin_t))
                }
                _ => None,
            }
        })
    }

    /// One representation item → its EXACT oriented box, unwrapping IfcBooleanClippingResult
    /// / IfcMappedItem to the IfcExtrudedAreaSolid. `None` unless it is a rectangular prism.
    /// Frame + extents from the parametrics (× unit_scale, − rtc_offset to match the mesh).
    pub(super) fn rect_param_from_item(
        &self,
        item: DecodedEntity,
        placement: &Matrix4<f64>,
        decoder: &mut EntityDecoder,
    ) -> Result<Option<RectParam>> {
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
                    IfcType::IfcBooleanClippingResult | IfcType::IfcBooleanResult => {
                        current = probe_result!(terminal, decoder.resolve_ref(current.get(1)?))??;
                    }
                    IfcType::IfcMappedItem => {
                        let source =
                            probe_result!(terminal, decoder.resolve_ref(current.get(0)?))??;
                        let mapped_rep =
                            probe_result!(terminal, decoder.resolve_ref(source.get(1)?))??;
                        // MappingTarget · MappingOrigin, matching the mesh path
                        // exactly (#1985 taught the mesh path the origin; before
                        // that this probe had to DEFER whenever the origin was
                        // non-identity, since the recovered box would have sat off
                        // the rendered solid).
                        //
                        // A composition that FAILS to parse defers the whole item to
                        // the exact kernel (`?`) instead of continuing with an
                        // identity chain: swallowing the error would recover a box in
                        // the wrong frame, which is exactly what the removed
                        // non-identity-origin guard used to prevent.
                        if let Some(m) = probe_result!(
                            terminal,
                            self.mapped_item_transform(&current, &source, decoder)
                        )? {
                            chain *= m;
                        }
                        current =
                            probe_result!(terminal, decoder.resolve_ref_list(mapped_rep.get(3)?))?
                                .into_iter()
                                .next()?;
                    }
                    _ => return None,
                }
            };

            let profile = probe_result!(terminal, decoder.resolve_ref(solid.get(0)?))??;
            let (x_dim, y_dim, off_x, off_y, cos_t, sin_t) = probe_result!(
                terminal,
                self.read_rect_profile_2d_checked(&profile, decoder)
            )??;
            let depth = solid.get_float(3)?;
            if !(x_dim.is_finite()
                && y_dim.is_finite()
                && depth.is_finite()
                && x_dim > 0.0
                && y_dim > 0.0
                && depth > 0.0)
            {
                return None;
            }
            let solid_pos = match solid.get(1) {
                Some(a) if !a.is_null() => {
                    let e = probe_result!(terminal, decoder.resolve_ref(a))??;
                    probe_result!(terminal, self.parse_axis2_placement_3d(&e, decoder))?
                }
                _ => Matrix4::identity(),
            };
            let dir_local = {
                let e = probe_result!(terminal, decoder.resolve_ref(solid.get(2)?))??;
                probe_result!(terminal, self.parse_direction(&e))?
            };

            let u = Vector3::new(cos_t, sin_t, 0.0);
            let v = Vector3::new(-sin_t, cos_t, 0.0);
            let w = dir_local.try_normalize(1e-12)?;
            let m = placement * chain * solid_pos;
            let rot = m.fixed_view::<3, 3>(0, 0).into_owned();
            let (ru, rv, rw) = (rot * u, rot * v, rot * w);
            let uu = ru.try_normalize(1e-9)?;
            let vv = rv.try_normalize(1e-9)?;
            let ww = rw.try_normalize(1e-9)?;
            // A mapped chain can carry SCALE (an IfcCartesianTransformationOperator's
            // Scale / Scale2 / Scale3), which normalizing the axes above discards. The
            // profile's authored XDim/YDim/Depth must pick it up from the transformed
            // axis LENGTHS, or a Scale = 1000 mapped opening recovers a cutter 1000x
            // too small while the mesh renders the big one. Exactly 1.0 is substituted
            // for a length that is 1 to within 1e-9, so a pure-rotation chain (every
            // corpus opening) keeps its previous bits. #1985
            let axis_scale = |n: f64| if (n - 1.0).abs() < 1e-9 { 1.0 } else { n };
            let (su, sv, sw) = (
                axis_scale(ru.norm()),
                axis_scale(rv.norm()),
                axis_scale(rw.norm()),
            );
            // A RectParam is an ORIENTED BOX, so the transformed axes must stay mutually
            // perpendicular. A shearing chain would silently recover a box that is not
            // the rendered solid; defer it to the exact kernel instead.
            if uu.dot(&vv).abs() > 1e-6 || uu.dot(&ww).abs() > 1e-6 || vv.dot(&ww).abs() > 1e-6 {
                return None;
            }
            let center_local = Point3::new(off_x, off_y, 0.0) + w * (depth * 0.5);
            let center_native = m.transform_point(&center_local);
            let s = self.unit_scale;
            let (rx, ry, rz) = self.rtc_offset;
            Some(RectParam {
                r: Matrix3::from_columns(&[uu, vv, ww]),
                center: Point3::new(
                    center_native.x * s - rx,
                    center_native.y * s - ry,
                    center_native.z * s - rz,
                ),
                half: [
                    x_dim * 0.5 * su * s,
                    y_dim * 0.5 * sv * s,
                    depth * 0.5 * sw * s,
                ],
            })
        })
    }
}
