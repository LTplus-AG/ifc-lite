// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #9011: `GltfOptions::with_name_by_global_id` makes each IFC element one node
//! under the scene, named by its `GlobalId`, holding its part nodes.
//!
//! Checked on every from-bytes assembler (in-memory GLB, bounded GLB,
//! multi-buffer glTF), against the same export without the option:
//!
//! * the binary payload, accessors, meshes and materials are identical, and so
//!   are the part nodes themselves;
//! * every part node lands at exactly the same world pose (the element node
//!   carries a copy of the root transform, so the chain is the same matrices);
//! * each element node is named by its `GlobalId`, its children are exactly
//!   that element's parts, and an element without a usable `GlobalId` keeps an
//!   unnamed node of its own.
//!
//! The model is synthetic and deliberately awkward: a translated, 30-degree
//! yawed site at Swiss LV95 magnitude (the root carries both translation and
//! rotation), a two-part element (two body items in different colours), and
//! elements whose `GlobalId` is blank or absent. A second, in-tree fixture with
//! mapped items covers the instanced occurrence nodes.

use std::collections::{BTreeMap, BTreeSet};

use ifc_lite_export::{
    export_gltf_streaming, project_glb_size, try_export_glb_streaming_bounded,
    try_export_glb_with_stats, GltfOptions,
};
use serde_json::Value;

const WALL_GUID: &str = "1wall0000000000000000A";
const SLAB_GUID: &str = "1slab0000000000000000B";

/// One extruded box item `#{id}` of size `x`·`y`·`h` at `(ox, oy)`, styled
/// `rgb`. Uses ids `id..id+9`.
fn styled_box(id: u32, origin: [f64; 2], size: [f64; 3], rgb: [f64; 3]) -> String {
    let [ox, oy] = origin;
    let [x, y, h] = size;
    let [r, g, b] = rgb;
    format!(
        "#{id}=IFCEXTRUDEDAREASOLID(#{p},#{a},#{d},{h:?});
#{p}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#{p2},{x:?},{y:?});
#{p2}=IFCAXIS2PLACEMENT2D(#{pc},$);
#{pc}=IFCCARTESIANPOINT(({ox:?},{oy:?}));
#{a}=IFCAXIS2PLACEMENT3D(#{ac},$,$);
#{ac}=IFCCARTESIANPOINT((0.,0.,0.));
#{d}=IFCDIRECTION((0.,0.,1.));
#{c}=IFCCOLOURRGB($,{r:?},{g:?},{b:?});
#{s}=IFCSURFACESTYLE($,.BOTH.,(#{sr}));
#{sr}=IFCSURFACESTYLESHADING(#{c},0.);
#{si}=IFCSTYLEDITEM(#{id},(#{s}),$);
",
        p = id + 1,
        p2 = id + 2,
        pc = id + 3,
        a = id + 4,
        ac = id + 5,
        d = id + 6,
        c = id + 7,
        s = id + 8,
        sr = id + 9,
        si = id + 10,
    )
}

/// An element `#{id}` of class `class` with GlobalId field `guid` (already
/// quoted, or `$`), placed at `at` in the site, whose Body holds `items`.
fn element(id: u32, class: &str, guid: &str, at: [f64; 3], items: &[u32]) -> String {
    let items = items.iter().map(|i| format!("#{i}")).collect::<Vec<_>>().join(",");
    let [x, y, z] = at;
    format!(
        "#{id}={class}({guid},$,'E{id}',$,$,#{lp},#{ps},$);
#{lp}=IFCLOCALPLACEMENT(#41,#{ap});
#{ap}=IFCAXIS2PLACEMENT3D(#{pt},$,$);
#{pt}=IFCCARTESIANPOINT(({x:?},{y:?},{z:?}));
#{ps}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{sr}));
#{sr}=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',({items}));
",
        lp = id + 1,
        ap = id + 2,
        pt = id + 3,
        ps = id + 4,
        sr = id + 5,
    )
}

fn model() -> String {
    model_with("")
}

/// [`model`] plus `extra` STEP records.
fn model_with(extra: &str) -> String {
    // 30-degree yaw: x axis (cos 30, sin 30).
    let (c, s) = (30f64.to_radians().cos(), 30f64.to_radians().sin());
    let mut data = format!(
        "#1=IFCPROJECT('0project00000000000001',$,'P',$,$,$,$,(#20),#30);
#30=IFCUNITASSIGNMENT((#31));
#31=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#21,$);
#21=IFCAXIS2PLACEMENT3D(#22,$,$);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#40=IFCSITE('0site000000000000000001',$,'S',$,$,#41,$,$,.ELEMENT.,$,$,$,$,$);
#41=IFCLOCALPLACEMENT($,#42);
#42=IFCAXIS2PLACEMENT3D(#43,#44,#45);
#43=IFCCARTESIANPOINT((2600000.3,1200000.7,410.25));
#44=IFCDIRECTION((0.,0.,1.));
#45=IFCDIRECTION(({c:?},{s:?},0.));
#70=IFCRELAGGREGATES('0agg0000000000000000001',$,$,$,#1,(#40));
#71=IFCRELCONTAINEDINSPATIALSTRUCTURE('0con0000000000000000001',$,$,$,(#500,#600,#700,#800),#40);
"
    );
    // A two-part wall: a grey core and a red layer beside it, two body items.
    data += &styled_box(100, [2.0, 0.1], [4.0, 0.2, 3.0], [0.6, 0.6, 0.6]);
    data += &styled_box(200, [2.0, 0.3], [4.0, 0.2, 3.0], [0.8, 0.1, 0.1]);
    data += &element(500, "IFCWALL", &format!("'{WALL_GUID}'"), [5.0, 3.0, 0.0], &[100, 200]);
    // A one-part slab.
    data += &styled_box(300, [3.0, 3.0], [6.0, 6.0, 0.3], [0.2, 0.4, 0.8]);
    data += &element(600, "IFCSLAB", &format!("'{SLAB_GUID}'"), [0.0, 0.0, -0.3], &[300]);
    // Blank and absent GlobalIds: no name a tool could resolve.
    data += &styled_box(320, [0.5, 0.5], [1.0, 1.0, 1.0], [0.1, 0.7, 0.1]);
    data += &element(700, "IFCBUILDINGELEMENTPROXY", "''", [10.0, 0.0, 0.0], &[320]);
    data += &styled_box(340, [0.5, 0.5], [1.0, 1.0, 1.0], [0.7, 0.7, 0.1]);
    data += &element(800, "IFCBUILDINGELEMENTPROXY", "$", [12.0, 0.0, 0.0], &[340]);
    data += extra;
    format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
{data}ENDSEC;
END-ISO-10303-21;
"
    )
}

/// GLB → (JSON, BIN).
fn parse_glb(glb: &[u8]) -> (Value, Vec<u8>) {
    assert_eq!(&glb[0..4], b"glTF");
    let json_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    let json: Value = serde_json::from_slice(&glb[20..20 + json_len]).expect("GLB JSON");
    let bin_at = 20 + json_len;
    let bin_len = u32::from_le_bytes(glb[bin_at..bin_at + 4].try_into().unwrap()) as usize;
    (json, glb[bin_at + 8..bin_at + 8 + bin_len].to_vec())
}

/// Column-major local matrix of a node: `matrix`, or T·R·S, in f64.
fn local(node: &Value) -> [f64; 16] {
    let f = |v: &Value| v.as_f64().unwrap();
    if let Some(m) = node.get("matrix").and_then(Value::as_array) {
        return std::array::from_fn(|i| f(&m[i]));
    }
    let t = node.get("translation").map_or([0.0; 3], |t| [f(&t[0]), f(&t[1]), f(&t[2])]);
    let [x, y, z, w] = node.get("rotation").map_or([0.0, 0.0, 0.0, 1.0], |q| {
        [f(&q[0]), f(&q[1]), f(&q[2]), f(&q[3])]
    });
    let s = node.get("scale").map_or([1.0; 3], |s| [f(&s[0]), f(&s[1]), f(&s[2])]);
    let r = [
        1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + z * w), 2.0 * (x * z - y * w),
        2.0 * (x * y - z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + x * w),
        2.0 * (x * z + y * w), 2.0 * (y * z - x * w), 1.0 - 2.0 * (x * x + y * y),
    ];
    [
        r[0] * s[0], r[1] * s[0], r[2] * s[0], 0.0,
        r[3] * s[1], r[4] * s[1], r[5] * s[1], 0.0,
        r[6] * s[2], r[7] * s[2], r[8] * s[2], 0.0,
        t[0], t[1], t[2], 1.0,
    ]
}

fn mul(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    std::array::from_fn(|i| {
        let (c, r) = (i / 4, i % 4);
        (0..4).map(|k| a[k * 4 + r] * b[c * 4 + k]).sum()
    })
}

/// World matrix of every node reachable from the scene.
fn world_matrices(json: &Value) -> BTreeMap<usize, [f64; 16]> {
    let nodes = json["nodes"].as_array().unwrap();
    let mut out = BTreeMap::new();
    let identity: [f64; 16] = std::array::from_fn(|i| if i % 5 == 0 { 1.0 } else { 0.0 });
    let mut stack: Vec<(usize, [f64; 16])> = json["scenes"][0]["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| (n.as_u64().unwrap() as usize, identity))
        .collect();
    while let Some((i, parent)) = stack.pop() {
        let world = mul(&parent, &local(&nodes[i]));
        assert!(out.insert(i, world).is_none(), "node {i} reached twice");
        for c in nodes[i].get("children").and_then(Value::as_array).into_iter().flatten() {
            stack.push((c.as_u64().unwrap() as usize, world));
        }
    }
    out
}

/// What must not move: everything but the scene/node hierarchy.
fn payload(json: &Value) -> Value {
    let mut j = json.clone();
    let o = j.as_object_mut().unwrap();
    o.remove("nodes");
    o.remove("scenes");
    j
}

fn opts(name_by_global_id: bool, quantize: bool) -> GltfOptions {
    GltfOptions::default()
        .with_include_metadata(true)
        .with_quantize(quantize)
        .with_name_by_global_id(name_by_global_id)
}

/// Export with the option off and on, then [`check_pair`].
fn pair(label: &str, export: Assembler, bytes: &[u8], quantize: bool) -> (Exported, Vec<(Option<String>, usize)>) {
    let label = format!("{label}, quantize = {quantize}");
    let on = export(bytes, &opts(true, quantize));
    let elements = check_pair(&label, &export(bytes, &opts(false, quantize)), &on);
    (on, elements)
}

fn has_matrix_nodes(json: &Value) -> bool {
    json["nodes"].as_array().unwrap().iter().any(|n| n.get("matrix").is_some())
}

/// One export: (JSON, binary buffers).
type Exported = (Value, Vec<Vec<u8>>);
type Assembler = fn(&[u8], &GltfOptions) -> Exported;

/// The three from-bytes assemblers.
fn assemblers() -> Vec<(&'static str, Assembler)> {
    fn in_memory(b: &[u8], o: &GltfOptions) -> Exported {
        let (json, bin) = parse_glb(&try_export_glb_with_stats(b, o).expect("in-memory GLB").0);
        (json, vec![bin])
    }
    fn bounded(b: &[u8], o: &GltfOptions) -> Exported {
        let (json, bin) = parse_glb(&try_export_glb_streaming_bounded(b, o).expect("bounded GLB").0);
        (json, vec![bin])
    }
    fn multi_buffer(b: &[u8], o: &GltfOptions) -> Exported {
        let mut bufs = Vec::new();
        // A small cap so the model spans several buffers.
        let json = export_gltf_streaming(b, o, 4096, |buf| bufs.push(buf.bytes)).expect("glTF");
        (serde_json::from_slice(&json).expect("glTF JSON"), bufs)
    }
    vec![("in-memory", in_memory), ("bounded", bounded), ("multi-buffer", multi_buffer)]
}

/// Check one export pair; returns each element node's (name, part count).
fn check_pair(label: &str, off: &Exported, on: &Exported) -> Vec<(Option<String>, usize)> {
    let ((off, off_bin), (on, on_bin)) = (off, on);
    assert_eq!(off_bin, on_bin, "{label}: binary payload unchanged");
    assert_eq!(payload(off), payload(on), "{label}: accessors, meshes, materials unchanged");

    let off_nodes = off["nodes"].as_array().unwrap();
    let on_nodes = on["nodes"].as_array().unwrap();
    let off_scene = off["scenes"][0]["nodes"].as_array().unwrap();
    assert_eq!(off_scene.len(), 1, "{label}: default is one root");
    assert!(off_nodes.iter().all(|n| n.get("name").is_none()), "{label}: default names nothing");
    // Part nodes come first and are untouched; the top-level nodes follow.
    let parts = off_nodes.len() - 1;
    assert_eq!(off_nodes[..parts], on_nodes[..parts], "{label}: part nodes unchanged");

    let (off_world, on_world) = (world_matrices(off), world_matrices(on));
    let meshes: BTreeSet<usize> = (0..parts).filter(|&i| off_nodes[i].get("mesh").is_some()).collect();
    for &i in &meshes {
        assert_eq!(off_world[&i], on_world[&i], "{label}: part node {i} keeps its exact world pose");
    }

    let root = &off_nodes[off_scene[0].as_u64().unwrap() as usize];
    let mut seen: BTreeSet<usize> = BTreeSet::new();
    let mut elements = Vec::new();
    for top in on["scenes"][0]["nodes"].as_array().unwrap() {
        let top = top.as_u64().unwrap() as usize;
        assert!(top >= parts, "{label}: element nodes follow the part nodes");
        let node = &on_nodes[top];
        assert_eq!(node.get("translation"), root.get("translation"), "{label}: root translation copied");
        assert_eq!(node.get("rotation"), root.get("rotation"), "{label}: root rotation copied");
        assert!(node.get("mesh").is_none() && node.get("extras").is_none());
        let name = node.get("name").map(|n| n.as_str().unwrap().to_owned());
        let children: Vec<usize> =
            node["children"].as_array().unwrap().iter().map(|c| c.as_u64().unwrap() as usize).collect();
        // Every child's meshes belong to this element and carry its GlobalId.
        let mut ids = BTreeSet::new();
        for &c in &children {
            assert!(seen.insert(c), "{label}: part {c} under one element only");
            let mut stack = vec![c];
            while let Some(n) = stack.pop() {
                if let Some(extras) = on_nodes[n].get("extras") {
                    ids.insert(extras["expressId"].as_u64().unwrap());
                    let gid = extras.get("GlobalId").and_then(Value::as_str).filter(|g| !g.trim().is_empty());
                    assert_eq!(gid, name.as_deref(), "{label}: element name is its parts' GlobalId");
                }
                stack.extend(on_nodes[n].get("children").and_then(Value::as_array).into_iter().flatten()
                    .map(|v| v.as_u64().unwrap() as usize));
            }
        }
        assert_eq!(ids.len(), 1, "{label}: one element per node, got {ids:?}");
        elements.push((name, children.len()));
    }
    let root_children: BTreeSet<usize> =
        root["children"].as_array().unwrap().iter().map(|c| c.as_u64().unwrap() as usize).collect();
    assert_eq!(seen, root_children, "{label}: every part of the root, and only those, is grouped");
    elements
}

#[test]
fn issue_9011_every_assembler_names_element_nodes_by_global_id() {
    let bytes = model().into_bytes();
    for ((label, export), quantize) in assemblers().into_iter().flat_map(|a| [(a, false), (a, true)]) {
        let (_, elements) = pair(label, export, &bytes, quantize);
        let by_name: BTreeMap<Option<String>, Vec<usize>> =
            elements.iter().fold(BTreeMap::new(), |mut m, (n, c)| {
                m.entry(n.clone()).or_default().push(*c);
                m
            });
        assert_eq!(by_name.get(&Some(WALL_GUID.into())), Some(&vec![2]), "{label}: wall is two parts");
        assert_eq!(by_name.get(&Some(SLAB_GUID.into())), Some(&vec![1]), "{label}: {elements:?}");
        assert_eq!(by_name.get(&None), Some(&vec![1, 1]), "{label}: blank and absent GlobalIds stay unnamed");
        assert_eq!(elements.len(), 4, "{label}: one node per element");
    }
}

#[test]
fn issue_9011_instanced_occurrences_group_under_their_elements() {
    // Mapped items: the in-memory assembler places these through instanced
    // occurrence nodes, the bounded one through its own instancing plan.
    // Quantized, an occurrence is a dequant mesh node under a matrix parent,
    // and the parent is what the element node holds.
    let bytes = include_bytes!("../../geometry/tests/fixtures/mapped_instances_site_rotated.ifc");
    for ((label, export), quantize) in assemblers().into_iter().flat_map(|a| [(a, false), (a, true)]) {
        let ((json, _), elements) = pair(label, export, bytes, quantize);
        assert_eq!(elements.len(), 4, "{label}: four proxies, {elements:?}");
        assert!(elements.iter().all(|(name, _)| name.is_some()), "{label}: every proxy has a GlobalId");
        // The point of this fixture: both GLB assemblers really instance it
        // (the multi-buffer one never instances).
        assert_eq!(has_matrix_nodes(&json), label != "multi-buffer", "{label}, quantize = {quantize}: instancing");
    }
}

#[test]
fn issue_9011_metadata_is_independent_of_naming() {
    // Without `include_metadata` the parts carry no extras, but the element
    // nodes are still named: the option does not need metadata.
    let bytes = model().into_bytes();
    let on = GltfOptions::default().with_name_by_global_id(true);
    for (label, export) in assemblers() {
        let (json, _) = export(&bytes, &on);
        let nodes = json["nodes"].as_array().unwrap();
        assert!(nodes.iter().all(|n| n.get("extras").is_none()), "{label}");
        let names: BTreeSet<&str> = json["scenes"][0]["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|i| nodes[i.as_u64().unwrap() as usize].get("name")?.as_str())
            .collect();
        assert_eq!(names, BTreeSet::from([WALL_GUID, SLAB_GUID]), "{label}");
    }
}

#[test]
fn issue_9011_a_reused_step_id_does_not_put_one_element_under_anothers_name() {
    // Malformed input: a second entity reuses the wall's STEP id #500 with a
    // GlobalId of its own. Grouping by express id alone hung its part under the
    // wall's name, so a lookup by name returned the wrong object.
    const DUP_GUID: &str = "2dupid000000000000000C";
    let extra = styled_box(360, [0.5, 0.5], [1.0, 1.0, 1.0], [0.4, 0.4, 0.9])
        + &format!(
            "#500=IFCSLAB('{DUP_GUID}',$,'Dup',$,$,#901,#904,$);
#901=IFCLOCALPLACEMENT(#41,#902);
#902=IFCAXIS2PLACEMENT3D(#903,$,$);
#903=IFCCARTESIANPOINT((20.,0.,0.));
#904=IFCPRODUCTDEFINITIONSHAPE($,$,(#905));
#905=IFCSHAPEREPRESENTATION(#20,'Body','SweptSolid',(#360));
"
        );
    let bytes = model_with(&extra).into_bytes();
    for (label, export) in assemblers() {
        let (off, _) = export(&bytes, &opts(false, false));
        let exported_guids: BTreeSet<&str> = off["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|n| n.get("extras")?.get("GlobalId")?.as_str())
            .collect();
        if !exported_guids.contains(DUP_GUID) {
            // The parser kept one of the two records: nothing to group wrongly.
            eprintln!("{label}: the duplicate #500 was not exported; skipping");
            continue;
        }
        // `check_pair` asserts each element node is named by its parts' GlobalId.
        let (_, elements) = pair(label, export, &bytes, false);
        assert!(elements.iter().any(|(n, _)| n.as_deref() == Some(DUP_GUID)), "{label}: {elements:?}");
    }
}

#[test]
fn issue_9011_off_is_the_default_output() {
    let bytes = model().into_bytes();
    let default = try_export_glb_with_stats(&bytes, &GltfOptions::default()).unwrap().0;
    let off = try_export_glb_with_stats(&bytes, &GltfOptions::default().with_name_by_global_id(false)).unwrap().0;
    assert_eq!(default, off);
}

#[test]
fn issue_9011_size_projection_counts_the_element_nodes() {
    // The bounded path decides single GLB vs fallback from a projected size;
    // the extra nodes and names must be in it.
    let bytes = model().into_bytes();
    let size = |on: bool| {
        let projected = project_glb_size(&bytes, &opts(on, false)).total_bytes;
        let glb = try_export_glb_streaming_bounded(&bytes, &opts(on, false)).unwrap().0;
        assert_eq!(projected, glb.len() as u64, "name_by_global_id = {on}");
        projected
    };
    // Four element nodes, two of them named, cost JSON bytes the plan must see.
    assert!(size(true) > size(false), "the projection includes the element nodes");
}
