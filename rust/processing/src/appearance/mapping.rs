// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::source::{numbers, Source};
use super::types::{AppearanceItem, AppearanceRequest, Mapping, MappingFrame};
use ifc_lite_core::{AttributeValue as A, IfcType};
use ifc_lite_geometry::GeometryRouter;

pub(super) fn rows<const N: usize>(value: Option<&A>) -> Result<Vec<[f64; N]>, String> {
    let list = value
        .and_then(A::as_list)
        .ok_or("Missing coordinate list")?;
    if list.is_empty() || list.len() > super::budget::MAX_COORDINATE_ROWS {
        return Err("Coordinate count outside appearance budget".into());
    }
    list.iter().map(numbers).collect()
}
pub(super) fn triangles(value: Option<&A>, max: usize) -> Result<Vec<[u32; 3]>, String> {
    rows::<3>(value)?
        .into_iter()
        .map(|r| {
            if r.iter()
                .any(|n| *n < 1. || *n > max as f64 || n.fract() != 0.)
            {
                return Err("Invalid face/texture index".into());
            }
            Ok(r.map(|n| n as u32))
        })
        .collect()
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}
fn subtract(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(super) fn validate(mapping: &Mapping) -> Result<(), String> {
    let valid = match mapping {
        Mapping::ExistingUv {
            scale,
            offset,
            rotation_radians,
        } => {
            scale.iter().all(|v| v.is_finite() && *v != 0.)
                && offset.iter().all(|v| v.is_finite())
                && rotation_radians.is_finite()
        }
        Mapping::Planar {
            origin,
            axis_u,
            axis_v,
            metres_per_tile,
            ..
        } => {
            origin
                .iter()
                .chain(axis_u)
                .chain(axis_v)
                .all(|n| n.is_finite())
                && metres_per_tile.iter().all(|v| v.is_finite() && *v > 0.)
                && (dot(*axis_u, *axis_u) - 1.).abs() < 1e-6
                && (dot(*axis_v, *axis_v) - 1.).abs() < 1e-6
                && dot(*axis_u, *axis_v).abs() < 1e-6
        }
        Mapping::Box {
            origin,
            metres_per_tile,
            ..
        } => {
            origin.iter().all(|n| n.is_finite())
                && metres_per_tile.iter().all(|v| v.is_finite() && *v > 0.)
        }
    };
    if valid {
        Ok(())
    } else {
        Err("Invalid appearance mapping parameters".into())
    }
}

pub(super) fn map_item(
    source: &mut Source<'_>,
    request: &AppearanceRequest,
    product_id: u32,
    item_id: u32,
    budget: &mut super::budget::PlanBudget,
) -> Result<AppearanceItem, String> {
    let item = source.entity(item_id)?;
    if !matches!(item.get(4), None | Some(A::Null)) {
        return Err("PnIndex face sets are not supported yet".into());
    }
    let coordinate_id = item.get_ref(0).ok_or("Missing face-set Coordinates")?;
    let coordinate_entity = source.entity(coordinate_id)?;
    if coordinate_entity.ifc_type != IfcType::IfcCartesianPointList3D {
        return Err("Coordinates must be IfcCartesianPointList3D".into());
    }
    let point_count = coordinate_entity.get(0).and_then(A::as_list).ok_or("Missing coordinate list")?.len();
    let triangle_count = item.get(3).and_then(A::as_list).ok_or("Missing face indices")?.len();
    let uv_count = match &request.mapping {
        Mapping::Planar { .. } => point_count,
        Mapping::Box { .. } => triangle_count.checked_mul(3).ok_or(super::budget::BUDGET_ERROR)?,
        Mapping::ExistingUv { .. } => {
            let maps = source.texture_maps.get(&item_id).ok_or("No existing texture mapping")?;
            if maps.len() != 1 { return Err("Ambiguous existing texture maps".into()); }
            let map = source.entity(maps[0])?;
            let list = source.entity(map.get_ref(2).ok_or("Missing texture coordinate list")?)?;
            list.get(0).and_then(A::as_list).ok_or("Missing texture coordinate list")?.len()
        }
    };
    // Reserve before building projected arrays or invoking canonical meshing.
    budget.reserve(point_count, triangle_count, uv_count)?;
    let mut positions = rows::<3>(coordinate_entity.get(0))?;
    let coord_index = triangles(item.get(3), positions.len())?;
    let (mut tex_coords, tex_coord_index) = match &request.mapping {
        Mapping::ExistingUv {
            scale,
            offset,
            rotation_radians,
        } => {
            let maps = source
                .texture_maps
                .get(&item_id)
                .ok_or("No existing texture mapping")?;
            if maps.len() != 1 {
                return Err("Ambiguous existing texture maps".into());
            }
            let map_id = maps[0];
            let map = source.entity(map_id)?;
            let list_id = map.get_ref(2).ok_or("Missing texture coordinate list")?;
            let list = source.entity(list_id)?;
            if list.ifc_type != IfcType::IfcTextureVertexList {
                return Err("TexCoords must be IfcTextureVertexList".into());
            }
            let mut uv = rows::<2>(list.get(0))?;
            let indices = match map.get(3) {
                None | Some(A::Null) => {
                    if uv.len() != positions.len() {
                        return Err("Implicit UVs do not match Coordinates".into());
                    }
                    coord_index.clone()
                }
                value => triangles(value, uv.len())?,
            };
            if indices.len() != coord_index.len() {
                return Err("UV triangle count does not match CoordIndex".into());
            }
            let (sin, cos) = rotation_radians.sin_cos();
            for p in &mut uv {
                let x = p[0] * scale[0];
                let y = p[1] * scale[1];
                *p = [x * cos - y * sin + offset[0], x * sin + y * cos + offset[1]];
            }
            (uv, indices)
        }
        mapping => {
            let scale = source.decoder.length_unit_scale();
            if !scale.is_finite() || scale <= 0. {
                return Err("Invalid model length unit scale".into());
            }
            let frame = match mapping {
                Mapping::Planar { frame, .. } | Mapping::Box { frame, .. } => frame,
                _ => unreachable!(),
            };
            let transform = if matches!(frame, MappingFrame::World) {
                // Shared canonical placement resolver (translation in metres).
                let product = source.entity(product_id)?;
                source.validate_world_placement(&product)?;
                Some(
                    GeometryRouter::with_scale(scale)
                        .resolve_scaled_placement(&product, &mut source.decoder)
                        .map_err(|e| e.to_string())?,
                )
            } else {
                None
            };
            for p in &mut positions {
                *p = p.map(|v| v * scale);
                if let Some(m) = transform {
                    let [x, y, z] = *p;
                    *p = [
                        m[0] * x + m[4] * y + m[8] * z + m[12],
                        m[1] * x + m[5] * y + m[9] * z + m[13],
                        m[2] * x + m[6] * y + m[10] * z + m[14],
                    ];
                }
            }
            match mapping {
                Mapping::Planar {
                    origin,
                    axis_u,
                    axis_v,
                    metres_per_tile,
                    ..
                } => {
                    let uv = positions
                        .iter()
                        .map(|p| {
                            let d = subtract(*p, *origin);
                            [
                                dot(d, *axis_u) / metres_per_tile[0],
                                dot(d, *axis_v) / metres_per_tile[1],
                            ]
                        })
                        .collect();
                    (uv, coord_index)
                }
                Mapping::Box {
                    origin,
                    metres_per_tile,
                    ..
                } => {
                    let mut uv = Vec::with_capacity(coord_index.len() * 3);
                    let mut indices = Vec::with_capacity(coord_index.len());
                    for tri in &coord_index {
                        let pts = tri.map(|i| positions[i as usize - 1]);
                        let a = subtract(pts[1], pts[0]);
                        let b = subtract(pts[2], pts[0]);
                        let n = [
                            a[1] * b[2] - a[2] * b[1],
                            a[2] * b[0] - a[0] * b[2],
                            a[0] * b[1] - a[1] * b[0],
                        ];
                        if !n.iter().all(|v| v.is_finite()) || dot(n, n) <= 1e-24 {
                            return Err("Degenerate box projection triangle".into());
                        }
                        let axis = if n[0].abs() >= n[1].abs() && n[0].abs() >= n[2].abs() {
                            0
                        } else if n[1].abs() >= n[2].abs() {
                            1
                        } else {
                            2
                        };
                        let (u, v) = match axis {
                            0 => (1, 2),
                            1 => (0, 2),
                            _ => (0, 1),
                        };
                        let base = uv.len() as u32;
                        for p in pts {
                            let d = subtract(p, *origin);
                            uv.push([d[u] / metres_per_tile[u], d[v] / metres_per_tile[v]]);
                        }
                        indices.push([base + 1, base + 2, base + 3]);
                    }
                    (uv, indices)
                }
                _ => unreachable!(),
            }
        }
    };
    if tex_coords
        .iter()
        .flatten()
        .any(|v| !v.is_finite() || !(*v as f32).is_finite())
    {
        return Err("Mapped UVs exceed finite renderer range".into());
    }
    Ok(AppearanceItem {
        product_id,
        geometry_item_id: item_id,
        tex_coords: std::mem::take(&mut tex_coords),
        tex_coord_index,
        source_indices: Vec::new(),
        target_indices: Vec::new(),
        target_vertex_count: 0,
        preview_corner_uvs: Vec::new(),
        target_corner_normals: Vec::new(),
    })
}
