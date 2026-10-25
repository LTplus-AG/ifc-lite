// SPDX-License-Identifier: MPL-2.0
use ifc_lite_processing::{process, MeshData, ProcessingRequest, ProcessingResult};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

mod curved;
pub use curved::{check_analytic_band_sum, check_curved_door, report_layer_observation};
pub const CHECKER_RGBA: [u8; 16] = [
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
];

pub fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/synthetic-retained")
}
pub fn fixture(name: &str) -> String {
    std::fs::read_to_string(root().join(name)).expect("committed synthetic fixture missing")
}
pub fn case(name: &str) -> Value {
    serde_json::from_str::<Value>(&fixture("oracles.json")).unwrap()["cases"][name].clone()
}
pub fn tolerance(name: &str) -> f64 {
    serde_json::from_str::<Value>(&fixture("tolerances.json")).unwrap()[name]
        .as_f64()
        .unwrap()
}
pub fn face_area_tolerance() -> f64 {
    serde_json::from_str::<Value>(&fixture("face-area-tolerance.json")).unwrap()
        ["face_area_absolute_m2"]
        .as_f64()
        .unwrap()
}
pub fn number(v: &Value) -> f64 {
    v.as_f64().unwrap()
}
pub fn integer(v: &Value) -> u32 {
    v.as_u64().unwrap().try_into().unwrap()
}
pub fn product_id(oracle: &Value, role: &str) -> u32 {
    integer(
        &oracle["products"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["role"] == role)
            .unwrap()["id"],
    )
}
pub fn run(source: &str) -> ProcessingResult {
    process(
        source.as_bytes(),
        &ProcessingRequest::full_pass().instancing(false),
        &mut (),
    )
}
pub fn without_entity(source: &str, id: u32) -> String {
    source
        .lines()
        .filter(|l| !l.starts_with(&format!("#{id}=")))
        .collect::<Vec<_>>()
        .join("\n")
}
fn check(ok: bool, message: impl Into<String>) -> Result<(), String> {
    if ok {
        Ok(())
    } else {
        Err(message.into())
    }
}
fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
fn dot(a: [f64; 3], b: [f64; 3]) -> f64 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}
fn sub(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|k| a[k] - b[k])
}
fn vector(v: &Value) -> [f64; 3] {
    [0, 1, 2].map(|k| number(&v[k]))
}
fn position(mesh: &MeshData, i: u32) -> [f64; 3] {
    [0, 1, 2].map(|k| f64::from(mesh.positions[i as usize * 3 + k]) + mesh.origin[k])
}

/// Signed tetrahedral integral about one product-local reference point. Shared
/// reference is essential when a palette splits an otherwise closed boundary.
fn volume(meshes: &[&MeshData]) -> f64 {
    let anchor = position(meshes[0], 0);
    meshes
        .iter()
        .flat_map(|m| {
            m.indices.chunks_exact(3).map(move |t| {
                let [a, b, c] = [t[0], t[1], t[2]].map(|i| sub(position(m, i), anchor));
                dot(a, cross(b, c)) / 6.
            })
        })
        .sum::<f64>()
}
/// Inspect the named host only. Deleting a void relationship may change whether
/// an orphan opening is emitted; that must not masquerade as a host-volume kill.
pub fn host_volume(result: &ProcessingResult, id: u32) -> f64 {
    let meshes: Vec<_> = result
        .meshes
        .iter()
        .filter(|m| m.express_id == id)
        .collect();
    assert!(
        !meshes.is_empty(),
        "host #{id} missing from mutation output"
    );
    for mesh in &meshes {
        mesh_valid(mesh).unwrap();
    }
    volume(&meshes)
}

fn mesh_valid(mesh: &MeshData) -> Result<(), String> {
    check(
        !mesh.positions.is_empty() && !mesh.indices.is_empty(),
        "empty mesh",
    )?;
    check(
        mesh.positions
            .iter()
            .chain(&mesh.normals)
            .all(|v| v.is_finite()),
        "nonfinite geometry",
    )?;
    check(
        mesh.positions.len().is_multiple_of(3) && mesh.indices.len().is_multiple_of(3),
        "incomplete tuples",
    )?;
    check(
        mesh.indices
            .iter()
            .all(|&i| (i as usize) * 3 < mesh.positions.len()),
        "out-of-range index",
    )?;
    check(mesh.normals.len() == mesh.positions.len(), "normal count")?;
    let normal_tolerance = tolerance("normal_length_absolute");
    for n in mesh.normals.chunks_exact(3) {
        let len = n.iter().map(|v| f64::from(*v).powi(2)).sum::<f64>().sqrt();
        check((len - 1.).abs() <= normal_tolerance, "nonunit normal")?;
    }
    for t in mesh.indices.chunks_exact(3) {
        let normal = cross(
            sub(position(mesh, t[1]), position(mesh, t[0])),
            sub(position(mesh, t[2]), position(mesh, t[0])),
        );
        for &i in t {
            let n = [0, 1, 2].map(|k| f64::from(mesh.normals[i as usize * 3 + k]));
            check(dot(normal, n) >= -1e-8, "normal/winding disagreement")?;
        }
    }
    Ok(())
}
pub fn check_products(
    result: &ProcessingResult,
    oracle: &Value,
    curved: bool,
) -> Result<(), String> {
    let expected: BTreeSet<u32> = oracle["products"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|p| {
            std::iter::once(integer(&p["id"])).chain(p["opening_id"].as_u64().map(|id| id as u32))
        })
        .collect();
    let actual: BTreeSet<u32> = result.meshes.iter().map(|m| m.express_id).collect();
    check(
        expected == actual,
        format!("product count/ids {actual:?} != {expected:?}"),
    )?;
    for p in oracle["products"].as_array().unwrap() {
        let id = integer(&p["id"]);
        // The default exact request also emits opening cutter meshes. Count
        // and validate these explicitly, independently of the host's removed volume.
        if let Some(opening) = p["opening_id"].as_u64() {
            let cutters: Vec<_> = result
                .meshes
                .iter()
                .filter(|m| m.express_id == opening as u32)
                .collect();
            for cutter in &cutters {
                mesh_valid(cutter)?;
            }
            check(
                (volume(&cutters) - number(&p["opening_volume"])).abs()
                    <= tolerance("planar_volume_absolute"),
                "opening cutter volume",
            )?;
        }
        let meshes: Vec<_> = result
            .meshes
            .iter()
            .filter(|m| m.express_id == id)
            .collect();
        for m in &meshes {
            mesh_valid(m)?;
        }
        let tol = tolerance(if !curved {
            "planar_volume_absolute"
        } else if p["band"].is_null() {
            "curved_total_mesh_volume_absolute"
        } else {
            "curved_band_mesh_volume_absolute"
        });
        if p["basis_columns"].is_array() {
            check_bounds(&meshes, p)?;
        }
        let got = volume(&meshes);
        check(
            (got - number(&p["volume"])).abs() <= tol,
            format!(
                "#{id} {} volume {got} expected {} tolerance {tol}",
                p["role"], p["volume"]
            ),
        )?;
        if p["local_centroid"].is_array() {
            check_centroid(&meshes, p)?;
        }
    }
    Ok(())
}
pub fn check_single(result: &ProcessingResult, oracle: &Value) -> Result<(), String> {
    if let Some(gid) = oracle["GlobalId"].as_str() {
        check(
            result
                .meshes
                .iter()
                .all(|m| m.global_id.as_deref() == Some(gid)),
            "stable GlobalId mismatch",
        )?;
    }
    let wrapper = serde_json::json!({"products":[oracle]});
    check_products(result, &wrapper, false)
}
pub fn check_appearance(result: &ProcessingResult, oracle: &Value) -> Result<(), String> {
    for row in oracle["products"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|p| p["expected_colour"].is_array())
    {
        let id = integer(&row["id"]);
        let expected = [0, 1, 2, 3].map(|i| number(&row["expected_colour"][i]) as f32);
        let meshes: Vec<_> = result
            .meshes
            .iter()
            .filter(|m| m.express_id == id)
            .collect();
        check(
            !meshes.is_empty() && meshes.iter().all(|m| m.color == expected),
            format!("occurrence {} style", row["role"].as_str().unwrap()),
        )?;
    }
    let palette = product_id(oracle, "palette");
    let row = oracle["products"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["role"] == "palette")
        .unwrap();
    let translation = vector(&row["translation"]);
    let expected = oracle["palette"]["source_triangles"].as_array().unwrap();
    let spatial_tolerance = tolerance("position_absolute");
    let mut seen = BTreeSet::new();
    for mesh in result.meshes.iter().filter(|m| m.express_id == palette) {
        for triangle in mesh.indices.chunks_exact(3) {
            let points = [triangle[0], triangle[1], triangle[2]]
                .map(|i| sub(position(mesh, i), translation));
            let index = expected
                .iter()
                .position(|t| {
                    t["vertices"].as_array().unwrap().iter().all(|v| {
                        points.iter().any(|p| {
                            sub(*p, vector(v))
                                .iter()
                                .all(|d| d.abs() <= spatial_tolerance)
                        })
                    })
                })
                .ok_or("unknown source palette triangle")?;
            check(seen.insert(index), "duplicated source palette triangle")?;
            let colour_index = integer(&expected[index]["palette_index"]) as usize;
            let colour = &oracle["palette"]["colours"][colour_index];
            let expected_colour = [
                number(&colour[0]) as f32,
                number(&colour[1]) as f32,
                number(&colour[2]) as f32,
                1.,
            ];
            check(
                mesh.color == expected_colour,
                "palette colour bound to wrong source triangle",
            )?;
        }
    }
    check(
        seen.len() == expected.len(),
        "missing source palette triangle",
    )?;
    let tex = product_id(oracle, "textured");
    let textured: Vec<_> = result
        .meshes
        .iter()
        .filter(|m| m.express_id == tex)
        .collect();
    check(!textured.is_empty(), "missing texture occurrence")?;
    for m in textured {
        let t = m.texture.as_ref().ok_or("missing mapped texture")?;
        check(
            t.texture_id == integer(&oracle["texture_id"]),
            "texture binding",
        )?;
        check(
            m.uvs
                .as_ref()
                .is_some_and(|uv| uv.len() == m.positions.len() / 3 * 2),
            "mapped UV count",
        )?;
    }
    check_uv(result, &oracle["texture"])?;
    Ok(())
}
pub fn check_uv(result: &ProcessingResult, oracle: &Value) -> Result<(), String> {
    let id = integer(&oracle["id"]);
    let meshes: Vec<_> = result
        .meshes
        .iter()
        .filter(|m| m.express_id == id)
        .collect();
    check(!meshes.is_empty(), "missing UV mesh")?;
    let mut seen = BTreeSet::new();
    for m in meshes {
        let t = m.texture.as_ref().ok_or("texture absent")?;
        check(
            t.texture_id == integer(&oracle["texture_id"])
                && t.url
                    .as_deref()
                    .is_none_or(|url| Some(url) == oracle["url"].as_str())
                && (t.url.is_some() || t.rgba.is_some()),
            "texture source identity",
        )?;
        check(t.repeat_s && !t.repeat_t, "texture sampler/reference")?;
        if let Some(rgba) = &t.rgba {
            check(
                t.width == 2 && t.height == 2 && rgba.as_slice() == CHECKER_RGBA,
                "decoded sidecar pixels",
            )?;
        }
        let uv = m.uvs.as_ref().ok_or("UV absent")?;
        check(uv.len() == m.positions.len() / 3 * 2, "UV count")?;
        for i in 0..m.positions.len() / 3 {
            let p = position(m, i as u32);
            let corner = oracle["vertices"]
                .as_array()
                .unwrap()
                .iter()
                .position(|v| {
                    sub(p, vector(v))
                        .iter()
                        .all(|d| d.abs() <= tolerance("position_absolute"))
                })
                .ok_or("unknown textured vertex")?;
            for k in 0..2 {
                check(
                    (f64::from(uv[i * 2 + k]) - number(&oracle["exact_uv"][corner][k])).abs()
                        <= tolerance("uv_absolute"),
                    "UV differs from source chart",
                )?;
            }
            seen.insert(corner);
        }
    }
    check(
        seen.len() == oracle["vertices"].as_array().unwrap().len(),
        "missing source UV corner",
    )
}

pub fn semantic_faces(
    result: &ProcessingResult,
    oracle: &Value,
) -> Result<BTreeMap<String, f64>, String> {
    let basis: Vec<_> = oracle["basis_columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(vector)
        .collect();
    let translation = vector(&oracle["translation"]);
    let to_local = |p| {
        let d = sub(p, translation);
        [dot(d, basis[0]), dot(d, basis[1]), dot(d, basis[2])]
    };
    let roles = [
        ("x_min", 0, 0., 3.),
        ("x_max", 0, 2., 3.),
        ("y_min", 1, 0., 6.),
        ("y_max", 1, 1., 6.),
        ("bottom", 2, 0., 2.),
        ("top", 2, 3., 2.),
    ];
    let mut areas = BTreeMap::new();
    for m in &result.meshes {
        for t in m.indices.chunks_exact(3) {
            let points = [t[0], t[1], t[2]].map(|i| to_local(position(m, i)));
            let role = roles
                .iter()
                .find(|(_, axis, value, _)| {
                    points
                        .iter()
                        .all(|p| (p[*axis] - value).abs() <= tolerance("position_absolute"))
                })
                .ok_or("triangle has no source semantic face")?;
            let normal = cross(sub(points[1], points[0]), sub(points[2], points[0]));
            let sign = if role.2 == 0. { -1. } else { 1. };
            check(normal[role.1] * sign > 0., "face winding reversed")?;
            let area = dot(normal, normal).sqrt() / 2.;
            let key = oracle["face_roles"][role.0]["key"]
                .as_str()
                .unwrap()
                .to_owned();
            *areas.entry(key).or_insert(0.) += area;
        }
    }
    for (role, _, _, want) in roles {
        let key = oracle["face_roles"][role]["key"].as_str().unwrap();
        let got = areas.get(key).ok_or("missing semantic face")?;
        check(
            (got - want).abs() <= face_area_tolerance(),
            format!("semantic face {key}: area {got} != {want}"),
        )?;
    }
    Ok(areas)
}

pub fn expand_instances(result: ProcessingResult) -> ProcessingResult {
    let mut expanded = result;
    let templates = expanded.meshes.clone();
    for record in &expanded.instances {
        for template in templates
            .iter()
            .filter(|m| m.express_id == record.template_express_id)
        {
            let mut mesh = template.clone();
            mesh.express_id = record.express_id;
            mesh.origin = [0.; 3];
            mesh.color = record.color;
            let t = record.transform.map(f64::from);
            for (i, p) in mesh.positions.chunks_exact_mut(3).enumerate() {
                let v = position(template, i as u32);
                for k in 0..3 {
                    p[k] = (t[k * 4] * v[0]
                        + t[k * 4 + 1] * v[1]
                        + t[k * 4 + 2] * v[2]
                        + t[k * 4 + 3]) as f32;
                }
            }
            let linear =
                nalgebra::Matrix3::new(t[0], t[1], t[2], t[4], t[5], t[6], t[8], t[9], t[10]);
            let normal_matrix = linear
                .try_inverse()
                .expect("nonsingular instance")
                .transpose();
            for n in mesh.normals.chunks_exact_mut(3) {
                let v = (normal_matrix
                    * nalgebra::Vector3::new(f64::from(n[0]), f64::from(n[1]), f64::from(n[2])))
                .normalize();
                for k in 0..3 {
                    n[k] = v[k] as f32;
                }
            }
            if linear.determinant() < 0. {
                for t in mesh.indices.chunks_exact_mut(3) {
                    t.swap(1, 2);
                }
            }
            expanded.meshes.push(mesh);
        }
    }
    expanded.instances.clear();
    expanded
}

fn check_bounds(meshes: &[&MeshData], p: &Value) -> Result<(), String> {
    let basis: Vec<_> = p["basis_columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(vector)
        .collect();
    let translation = vector(&p["translation"]);
    let scale = [0, 1, 2].map(|k| p["scale"][k].as_f64().unwrap_or(1.));
    let mut expected_min = [f64::INFINITY; 3];
    let mut expected_max = [f64::NEG_INFINITY; 3];
    for x in [0., 2.] {
        for y in [0., 1.] {
            for z in [0., 3.] {
                for k in 0..3 {
                    let v = translation[k]
                        + basis[0][k] * x * scale[0]
                        + basis[1][k] * y * scale[1]
                        + basis[2][k] * z * scale[2];
                    expected_min[k] = expected_min[k].min(v);
                    expected_max[k] = expected_max[k].max(v);
                }
            }
        }
    }
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for m in meshes {
        for i in 0..m.positions.len() / 3 {
            let v = position(m, i as u32);
            for k in 0..3 {
                min[k] = min[k].min(v[k]);
                max[k] = max[k].max(v[k]);
            }
        }
    }
    for k in 0..3 {
        check(
            (min[k] - expected_min[k]).abs() <= tolerance("position_absolute")
                && (max[k] - expected_max[k]).abs() <= tolerance("position_absolute"),
            format!("occurrence bounds: {min:?}..{max:?} != {expected_min:?}..{expected_max:?}"),
        )?;
    }
    Ok(())
}

fn check_centroid(meshes: &[&MeshData], p: &Value) -> Result<(), String> {
    let anchor = position(meshes[0], 0);
    let mut signed_volume = 0.;
    let mut moment = [0.; 3];
    for mesh in meshes {
        for t in mesh.indices.chunks_exact(3) {
            let [a, b, c] = [t[0], t[1], t[2]].map(|i| sub(position(mesh, i), anchor));
            let v = dot(a, cross(b, c)) / 6.;
            signed_volume += v;
            for k in 0..3 {
                moment[k] += v * (a[k] + b[k] + c[k]) / 4.;
            }
        }
    }
    let basis: Vec<_> = p["basis_columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(vector)
        .collect();
    let translation = vector(&p["translation"]);
    let local = vector(&p["local_centroid"]);
    let scale = vector(&p["scale"]);
    for k in 0..3 {
        let actual = anchor[k] + moment[k] / signed_volume;
        let expected = translation[k]
            + (0..3)
                .map(|j| basis[j][k] * scale[j] * local[j])
                .sum::<f64>();
        check(
            (actual - expected).abs() <= tolerance("position_absolute"),
            format!("centroid axis {k}: {actual} != {expected}"),
        )?;
    }
    Ok(())
}
