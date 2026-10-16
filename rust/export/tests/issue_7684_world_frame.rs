// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7684 EXPORT-GEOM-1 / EXPORT-DATA-20: every from-bytes exporter puts a
//! georeferenced model where the GLB puts it.
//!
//! `process_geometry` bakes vertices into a frame: the RTC offset (or, for a
//! translated `IfcSite`, the site translation) is subtracted and, in the site
//! tier, the site rotation removed. The GLB restores that frame on its scene
//! root. OBJ and USD did not, so the same file came out kilometres apart, and
//! unrotated, depending on the format; the BOS archive carried no way back to
//! world at all.
//!
//! Two synthetic models at Swiss LV95 magnitude, where the f32 step is 0.25 m:
//! a translated, 30-degree-yawed site (the `site_local` tier: translation AND
//! rotation removed), and an identity site with far geometry (the `model_rtc`
//! tier: a detected anchor removed). Each format's world AABB has to match
//! both the analytic corners and the GLB's to 1 mm.

use ifc_lite_export::{export_obj, export_usd, try_export_glb, GltfOptions, ObjOptions, UsdOptions};
use serde_json::Value;

/// LV95-scale site origin. Not a multiple of the f32 step, so an f32 fold
/// shows up as a sub-metre error, not just a kilometre one.
const SITE: [f64; 3] = [2_600_000.3, 1_200_000.7, 410.25];
/// The wall's placement inside the site frame.
const WALL_AT: [f64; 3] = [5.0, 3.0, 0.0];
/// Wall box in its own frame: 4 m long, 0.2 m thick, 3 m high.
const WALL_SIZE: [f64; 3] = [4.0, 0.2, 3.0];
const TOL: f64 = 1e-3;

/// One wall in a site placed at `site` with x axis `x_dir`, the wall at
/// `wall` inside it.
fn model(site: [f64; 3], x_dir: [f64; 2], wall: [f64; 3]) -> String {
    format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0project00000000000001',$,'P',$,$,$,$,(#20),#30);
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#40=IFCSITE('0site000000000000000001',$,'S',$,$,#41,$,$,.ELEMENT.,$,$,$,$,$);
#41=IFCLOCALPLACEMENT($,#42);
#42=IFCAXIS2PLACEMENT3D(#43,#44,#45);
#43=IFCCARTESIANPOINT(({:?},{:?},{:?}));
#44=IFCDIRECTION((0.,0.,1.));
#45=IFCDIRECTION(({:?},{:?},0.));
#50=IFCWALL('0wall000000000000000001',$,'W',$,$,#51,#60,$);
#51=IFCLOCALPLACEMENT(#41,#52);
#52=IFCAXIS2PLACEMENT3D(#53,$,$);
#53=IFCCARTESIANPOINT(({:?},{:?},{:?}));
#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61));
#61=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#62));
#62=IFCEXTRUDEDAREASOLID(#63,#66,#69,{:?});
#63=IFCRECTANGLEPROFILEDEF(.AREA.,$,#64,{:?},{:?});
#64=IFCAXIS2PLACEMENT2D(#65,$);
#65=IFCCARTESIANPOINT(({:?},{:?}));
#66=IFCAXIS2PLACEMENT3D(#67,$,$);
#67=IFCCARTESIANPOINT((0.,0.,0.));
#69=IFCDIRECTION((0.,0.,1.));
#70=IFCRELAGGREGATES('0agg0000000000000000001',$,$,$,#1,(#40));
#71=IFCRELCONTAINEDINSPATIALSTRUCTURE('0con0000000000000000001',$,$,$,(#50),#40);
ENDSEC;
END-ISO-10303-21;
",
        site[0], site[1], site[2], x_dir[0], x_dir[1], wall[0], wall[1], wall[2],
        WALL_SIZE[2], WALL_SIZE[0], WALL_SIZE[1], WALL_SIZE[0] / 2.0, WALL_SIZE[1] / 2.0,
    )
}

/// `site_local` tier: the site is translated AND yawed 30 degrees.
fn rotated_far_site() -> (String, Aabb) {
    let (s, c) = 30.0f64.to_radians().sin_cos();
    let corners = box_corners().map(|p| {
        let q = [WALL_AT[0] + p[0], WALL_AT[1] + p[1], WALL_AT[2] + p[2]];
        [SITE[0] + c * q[0] - s * q[1], SITE[1] + s * q[0] + c * q[1], SITE[2] + q[2]]
    });
    (model(SITE, [c, s], WALL_AT), aabb(&corners))
}

/// `model_rtc` tier: the site sits at the origin, the wall carries the far
/// coordinates, so the RTC detector's anchor is what the bake removes.
fn far_geometry_identity_site() -> (String, Aabb) {
    let at = [SITE[0] + WALL_AT[0], SITE[1] + WALL_AT[1], SITE[2] + WALL_AT[2]];
    let corners = box_corners().map(|p| [at[0] + p[0], at[1] + p[1], at[2] + p[2]]);
    (model([0.0; 3], [1.0, 0.0], at), aabb(&corners))
}

fn box_corners() -> [[f64; 3]; 8] {
    std::array::from_fn(|i| {
        [0, 1, 2].map(|k| if i >> k & 1 == 1 { WALL_SIZE[k] } else { 0.0 })
    })
}

type Aabb = ([f64; 3], [f64; 3]);

fn aabb(points: &[[f64; 3]]) -> Aabb {
    assert!(!points.is_empty(), "no geometry to bound");
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    for p in points {
        for k in 0..3 {
            lo[k] = lo[k].min(p[k]);
            hi[k] = hi[k].max(p[k]);
        }
    }
    (lo, hi)
}

/// `None` when `got` is `want` to [`TOL`] on every axis, else what is off.
fn misplaced(format: &str, got: Aabb, want: Aabb) -> Option<String> {
    (0..3).find_map(|k| {
        let (dlo, dhi) = (got.0[k] - want.0[k], got.1[k] - want.1[k]);
        (dlo.abs() >= TOL || dhi.abs() >= TOL).then(|| {
            format!(
                "{format}: axis {k} spans [{}, {}], expected [{}, {}] (off by {dlo:.4} / {dhi:.4} m)",
                got.0[k], got.1[k], want.0[k], want.1[k],
            )
        })
    })
}

/// WebGL Y-up back to IFC Z-up: `(x, y, z) -> (x, -z, y)`.
fn zup(p: [f64; 3]) -> [f64; 3] {
    [p[0], -p[2], p[1]]
}

/// Column-major `a * b`.
fn mat_mul(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    std::array::from_fn(|i| {
        let (col, row) = (i / 4, i % 4);
        (0..4).map(|k| a[k * 4 + row] * b[col * 4 + k]).sum()
    })
}

fn apply(m: &[f64; 16], p: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|r| m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r])
}

/// A glTF node's local matrix: `matrix`, or `T · R · S`.
fn node_local(node: &Value) -> [f64; 16] {
    let nums = |k: &str| -> Option<Vec<f64>> {
        node.get(k).and_then(Value::as_array).map(|a| a.iter().map(|v| v.as_f64().unwrap()).collect())
    };
    if let Some(m) = nums("matrix") {
        return std::array::from_fn(|i| m[i]);
    }
    let t = nums("translation").unwrap_or(vec![0.0; 3]);
    let s = nums("scale").unwrap_or(vec![1.0; 3]);
    let q = nums("rotation").unwrap_or(vec![0.0, 0.0, 0.0, 1.0]);
    let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
    let r = [
        1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + z * w), 2.0 * (x * z - y * w),
        2.0 * (x * y - z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + x * w),
        2.0 * (x * z + y * w), 2.0 * (y * z - x * w), 1.0 - 2.0 * (x * x + y * y),
    ];
    let mut m = [0.0; 16];
    for c in 0..3 {
        for row in 0..3 {
            m[c * 4 + row] = r[c * 3 + row] * s[c];
        }
    }
    m[12..15].copy_from_slice(&t);
    m[15] = 1.0;
    m
}

/// Every vertex of a GLB in IFC world (Z-up), walking the whole node graph.
fn glb_world(glb: &[u8]) -> Vec<[f64; 3]> {
    let json_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    let json: Value = serde_json::from_slice(&glb[20..20 + json_len]).unwrap();
    let bin = &glb[20 + json_len + 8..];
    let identity: [f64; 16] = std::array::from_fn(|i| if i % 5 == 0 { 1.0 } else { 0.0 });
    let mut stack: Vec<(usize, [f64; 16])> = json["scenes"][0]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| (n.as_u64().unwrap() as usize, identity))
        .collect();
    let mut out = Vec::new();
    while let Some((ni, parent)) = stack.pop() {
        let node = &json["nodes"][ni];
        let world = mat_mul(&parent, &node_local(node));
        if let Some(mi) = node.get("mesh").and_then(Value::as_u64) {
            for prim in json["meshes"][mi as usize]["primitives"].as_array().unwrap() {
                let acc = &json["accessors"][prim["attributes"]["POSITION"].as_u64().unwrap() as usize];
                assert_eq!(acc["componentType"], 5126, "f32 positions (quantize is off)");
                let bv = &json["bufferViews"][acc["bufferView"].as_u64().unwrap() as usize];
                let base = bv["byteOffset"].as_u64().unwrap_or(0) as usize
                    + acc["byteOffset"].as_u64().unwrap_or(0) as usize;
                let stride = bv["byteStride"].as_u64().unwrap_or(12) as usize;
                for i in 0..acc["count"].as_u64().unwrap() as usize {
                    let at = |k: usize| {
                        let o = base + i * stride + k * 4;
                        f32::from_le_bytes(bin[o..o + 4].try_into().unwrap()) as f64
                    };
                    out.push(zup(apply(&world, [at(0), at(1), at(2)])));
                }
            }
        }
        for c in node.get("children").and_then(Value::as_array).into_iter().flatten() {
            stack.push((c.as_u64().unwrap() as usize, world));
        }
    }
    out
}

/// Every `v` line of an OBJ, back in Z-up.
fn obj_world(obj: &str) -> Vec<[f64; 3]> {
    obj.lines()
        .filter_map(|l| l.strip_prefix("v "))
        .map(|l| {
            let v: Vec<f64> = l.split_whitespace().map(|t| t.parse().unwrap()).collect();
            zup([v[0], v[1], v[2]])
        })
        .collect()
}

/// The numbers inside the first `(...)`-delimited run after `key`.
fn numbers_after(text: &str, key: &str) -> Option<Vec<f64>> {
    let rest = &text[text.find(key)? + key.len()..];
    let line = rest.lines().next()?;
    Some(
        line.split(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == 'e' || c == '+'))
            .filter(|t| !t.is_empty())
            .map(|t| t.parse().unwrap())
            .collect(),
    )
}

/// Every mesh point of a USDA stage in world: `/World`'s transform, then each
/// Mesh's own translate. Element Xforms are identity grouping.
fn usd_world(usda: &str) -> Vec<[f64; 3]> {
    let mut blocks = usda.split("def Mesh ");
    let head = blocks.next().unwrap();
    // `/World`'s own ops sit between its `{` and its first child prim.
    let world_ops = &head[head.find("def Xform \"World\"").unwrap()..];
    let world_ops = &world_ops[..world_ops[1..].find("def ").map_or(world_ops.len(), |i| i + 1)];
    let identity: [f64; 16] = std::array::from_fn(|i| if i % 5 == 0 { 1.0 } else { 0.0 });
    let root = numbers_after(world_ops, "matrix4d xformOp:transform =")
        .map_or(identity, |m| std::array::from_fn(|i| m[i]));
    let mut out = Vec::new();
    for block in blocks {
        let block = &block[..block.find("\ndef ").unwrap_or(block.len())];
        let Some(points) = numbers_after(block, "point3f[] points =") else { continue };
        let t = numbers_after(block, "double3 xformOp:translate =").unwrap_or(vec![0.0; 3]);
        for p in points.chunks_exact(3) {
            out.push(apply(&root, [p[0] + t[0], p[1] + t[1], p[2] + t[2]]));
        }
    }
    out
}

/// One table out of a BOS archive.
#[cfg(feature = "parquet-bos")]
fn bos_entry(archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>, name: &str) -> Vec<u8> {
    use std::io::Read;
    let mut bytes = Vec::new();
    archive.by_name(name).unwrap().read_to_end(&mut bytes).unwrap();
    bytes
}

/// Every BOS vertex in world: `Metadata.json`'s `worldTransform` applied to
/// the f32 columns, in f64 (identity when the archive carries none).
#[cfg(feature = "parquet-bos")]
fn bos_world(bos: Vec<u8>) -> Vec<[f64; 3]> {
    use arrow::array::AsArray;
    use arrow::datatypes::Float32Type;
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bos)).unwrap();
    let meta: Value = serde_json::from_slice(&bos_entry(&mut archive, "Metadata.json")).unwrap();
    let identity: [f64; 16] = std::array::from_fn(|i| if i % 5 == 0 { 1.0 } else { 0.0 });
    let m = meta["worldTransform"]
        .as_array()
        .map_or(identity, |a| std::array::from_fn(|i| a[i].as_f64().unwrap()));
    // A path unique per call: tests run in parallel threads of one process, so
    // the pid alone raced.
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!("ifc-lite-7684-{}-{n}.parquet", std::process::id()));
    std::fs::write(&path, bos_entry(&mut archive, "VertexBuffer.parquet")).unwrap();
    let batches: Vec<_> = ParquetRecordBatchReaderBuilder::try_new(std::fs::File::open(&path).unwrap())
        .unwrap()
        .build()
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let _ = std::fs::remove_file(&path);
    let col = |name: &str| -> Vec<f64> {
        batches
            .iter()
            .flat_map(|b| b.column_by_name(name).unwrap().as_primitive::<Float32Type>().values().to_vec())
            .map(f64::from)
            .collect()
    };
    let (x, y, z) = (col("X"), col("Y"), col("Z"));
    (0..x.len()).map(|i| apply(&m, [x[i], y[i], z[i]])).collect()
}

/// Every format is checked before failing, so one red run names each format
/// that is off rather than only the first.
fn check_every_format(ifc: &str, want: Aabb) {
    let bytes = ifc.as_bytes();
    let glb = aabb(&glb_world(&try_export_glb(bytes, &GltfOptions::default()).expect("GLB")));
    // The GLB was already right: it is the reference the others must agree with.
    let mut off: Vec<String> = misplaced("glb vs analytic", glb, want).into_iter().collect();
    off.extend(misplaced("obj", aabb(&obj_world(&export_obj(bytes, &ObjOptions::default()))), glb));
    for instancing in [true, false] {
        let usda = export_usd(bytes, &UsdOptions { instancing, ..UsdOptions::default() });
        off.extend(misplaced(&format!("usd (instancing {instancing})"), aabb(&usd_world(&usda)), glb));
    }
    #[cfg(feature = "parquet-bos")]
    {
        let bos = ifc_lite_export::export_bos(bytes, &ifc_lite_export::ParquetBosOptions::default()).expect("BOS");
        off.extend(misplaced("parquet-bos", aabb(&bos_world(bos)), glb));
    }
    assert!(off.is_empty(), "formats disagree with the GLB on where the model is:\n{}", off.join("\n"));
}

/// EXPORT-GEOM-1 (#7684), `site_local`: on base OBJ and USD land the wall at
/// the site origin's neighbourhood, unrotated, about 2,600 km from the GLB.
#[test]
fn issue_7684_a_rotated_far_site_lands_where_the_glb_puts_it() {
    let (ifc, want) = rotated_far_site();
    check_every_format(&ifc, want);
}

/// EXPORT-GEOM-1 (#7684), `model_rtc`: on base OBJ and USD drop the detected
/// anchor, so the wall lands next to the origin.
#[test]
fn issue_7684_far_geometry_under_an_identity_site_lands_where_the_glb_puts_it() {
    let (ifc, want) = far_geometry_identity_site();
    check_every_format(&ifc, want);
}

/// EXPORT-DATA-20 (#7684): the BOS columns are f32, so they stay in the baked
/// frame (small values), and the archive says how to get back to world, in
/// f64. On base there is no `worldTransform`, and the vertices are baked-frame
/// values a reader has no way to place.
#[cfg(feature = "parquet-bos")]
#[test]
fn issue_7684_bos_keeps_f32_columns_small_and_carries_the_way_back() {
    let (ifc, _) = rotated_far_site();
    let bos = ifc_lite_export::export_bos(ifc.as_bytes(), &ifc_lite_export::ParquetBosOptions::default())
        .expect("BOS");
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bos)).unwrap();
    let meta: Value = serde_json::from_slice(&bos_entry(&mut archive, "Metadata.json")).unwrap();
    assert_eq!(meta["meshCoordinateSpace"], "site_local", "{meta}");
    let m: Vec<f64> = meta["worldTransform"].as_array().expect("worldTransform").iter().map(|v| v.as_f64().unwrap()).collect();
    assert_eq!(&m[12..16], &[SITE[0], SITE[1], SITE[2], 1.0], "translation is the f64 site origin");
    let (s, c) = 30.0f64.to_radians().sin_cos();
    for (got, want) in m[0..3].iter().zip([c, s, 0.0]) {
        assert!((got - want).abs() < 1e-12, "x axis {:?}", &m[0..3]);
    }
}
