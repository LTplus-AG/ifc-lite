// SPDX-License-Identifier: MPL-2.0
//! Tests for the USDA exporter. The fixture `apps/landing/samples/hello-wall.ifc` is
//! git-tracked (unlike the staged `tests/models/*`), so these run on a fresh checkout
//! without `pnpm fixtures`. `usdchecker` is not available in CI, so a small in-test
//! USDA scanner (balanced scopes/parens, per-parent name uniqueness) plus a mesh parser
//! (points/normals/indices cross-checked against the source `MeshData`) are the
//! objective structural gate, backed by exact-syntax assertions for the metadata block,
//! `xformOpOrder`, `MaterialBindingAPI`, and `subdivisionScheme`.

use super::emit::emit_attributes;
use super::fmt::{color_key, escape_str, fmt_f32, fmt_f64, mat_name, sanitize_ident, Namer};
use super::instance::{
    emit_instance_occurrence, instances_authorable, run_instanced, usd_transform_rows,
};
use super::{export_usd, mesh_emittable, UsdOptions};
use crate::model::{EntityRow, PropValue, PropertySet};
use ifc_lite_processing::{process_geometry, InstanceRecord, MeshData};
use std::collections::HashSet;

/// Git-tracked hello-wall fixture (IFC4, metres): Project → Site → Building → Storey,
/// a meshed IfcWall (#1222) with `Pset_WallCommon.IsExternal`, surface styles.
fn hello_wall() -> Vec<u8> {
    let path =
        format!("{}/../../apps/landing/samples/hello-wall.ifc", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

fn export(bytes: &[u8]) -> String {
    export_usd(bytes, &UsdOptions::default())
}

// ── USDA structural scanner (the no-usdchecker objective gate) ───────────────

/// Blank out `"..."` string regions (respecting `\"`) so brace/paren counting and
/// def-detection never trip over punctuation inside a value.
fn strip_quotes(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let (mut in_str, mut esc) = (false, false);
    for c in line.chars() {
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
            out.push(' ');
        } else if c == '"' {
            in_str = true;
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

/// `def <Type> "<name>"` or `class <Type> "<name>"` → `(Type, name)`, else None.
fn def_of(trimmed: &str) -> Option<(String, String)> {
    let rest = trimmed.strip_prefix("def ").or_else(|| trimmed.strip_prefix("class "))?;
    let ty: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
    let start = rest.find('"')? + 1;
    let end = rest[start..].find('"')? + start;
    Some((ty, rest[start..end].to_string()))
}

/// Walk the stage body from `/World`, asserting braces AND parens balance and that no
/// two prims share a name within the same parent scope. Returns all `(type, name)` defs.
fn scan(usda: &str) -> Vec<(String, String)> {
    let start = usda.find("\ndef Xform \"World\"").expect("World prim present");
    let body = &usda[start + 1..];
    let mut scopes: Vec<HashSet<String>> = vec![HashSet::new()];
    let mut parens: i32 = 0;
    let mut defs = Vec::new();
    for raw in body.lines() {
        let t = raw.trim_start();
        if let Some((ty, name)) = def_of(t) {
            let fresh = scopes.last_mut().unwrap().insert(name.clone());
            assert!(fresh, "duplicate prim name `{name}` within one parent scope");
            defs.push((ty, name));
        }
        for c in strip_quotes(raw).chars() {
            match c {
                '{' => scopes.push(HashSet::new()),
                '}' => {
                    scopes.pop();
                    assert!(!scopes.is_empty(), "unbalanced `}}` in USDA");
                }
                '(' => parens += 1,
                ')' => parens -= 1,
                _ => {}
            }
            assert!(parens >= 0, "unbalanced `)` in USDA");
        }
    }
    assert_eq!(scopes.len(), 1, "unbalanced scopes (a `def` block never closed)");
    assert_eq!(parens, 0, "unbalanced prim-metadata parens");
    defs
}

/// Express ids encoded as the `_<id>` suffix of ELEMENT (`def Xform`) prim names only —
/// NOT materials/meshes/scopes, whose names (e.g. `Mat_20_85_100_30`, `geom_2`) would
/// otherwise leak spurious ids and mask a genuinely dropped element.
fn xform_ids(defs: &[(String, String)]) -> HashSet<u32> {
    let mut ids = HashSet::new();
    for (ty, name) in defs {
        if ty == "Xform" {
            if let Some(pos) = name.rfind('_') {
                if let Ok(id) = name[pos + 1..].parse::<u32>() {
                    ids.insert(id);
                }
            }
        }
    }
    ids
}

// ── mesh parser (content cross-check) ────────────────────────────────────────

#[derive(Default)]
struct ParsedMesh {
    points: Vec<f32>,
    normals: Vec<f32>,
    counts: Vec<u32>,
    indices: Vec<u32>,
    translate: Option<[f64; 3]>,
}

fn nums_f32(s: &str) -> Vec<f32> {
    s.split(['(', ')', ',', '[', ']', ' ', '\t'])
        .filter_map(|t| t.trim().parse::<f32>().ok())
        .collect()
}
fn nums_u32(s: &str) -> Vec<u32> {
    s.split(['(', ')', ',', '[', ']', ' ', '\t'])
        .filter_map(|t| t.trim().parse::<u32>().ok())
        .collect()
}

/// Parse every `def Mesh` block's array attributes (each is emitted on one line).
fn parse_meshes(usda: &str) -> Vec<ParsedMesh> {
    let mut out = Vec::new();
    let mut cur: Option<ParsedMesh> = None;
    for raw in usda.lines() {
        let t = raw.trim_start();
        if t.starts_with("def Mesh \"") {
            if let Some(m) = cur.take() {
                out.push(m);
            }
            cur = Some(ParsedMesh::default());
        } else if let Some(m) = cur.as_mut() {
            if let Some(a) = t.strip_prefix("point3f[] points = ") {
                m.points = nums_f32(a);
            } else if let Some(a) = t.strip_prefix("normal3f[] normals = ") {
                m.normals = nums_f32(a);
            } else if let Some(a) = t.strip_prefix("int[] faceVertexCounts = ") {
                m.counts = nums_u32(a);
            } else if let Some(a) = t.strip_prefix("int[] faceVertexIndices = ") {
                m.indices = nums_u32(a);
            } else if let Some(a) = t.strip_prefix("double3 xformOp:translate = ") {
                let v: Vec<f64> =
                    a.split(['(', ')', ',']).filter_map(|x| x.trim().parse::<f64>().ok()).collect();
                if v.len() == 3 {
                    m.translate = Some([v[0], v[1], v[2]]);
                }
            }
        }
    }
    if let Some(m) = cur.take() {
        out.push(m);
    }
    out
}

// ── tests ────────────────────────────────────────────────────────────────────

#[test]
fn exports_valid_usda_header_and_geometry() {
    let usda = export(&hello_wall());

    assert!(usda.starts_with("#usda 1.0\n(\n"), "must open with the magic + metadata block");
    let first_def = usda.find("\ndef ").expect("a root prim");
    let header = &usda[..first_def];
    assert!(header.contains("defaultPrim = \"World\""), "defaultPrim in layer metadata");
    assert!(header.contains("metersPerUnit = 1"), "metersPerUnit in layer metadata");
    assert!(header.contains("upAxis = \"Z\""), "upAxis in layer metadata");
    assert!(header.contains("customLayerData = {"), "author routed through customLayerData");

    assert!(usda.contains("def Xform \"World\""), "root World Xform");
    assert!(usda.contains("def Mesh \""), "at least one mesh");
    assert!(usda.contains("point3f[] points = ["), "mesh points");
    assert!(usda.contains("int[] faceVertexIndices = ["), "mesh indices");

    scan(&usda); // braces + parens balance, names unique per scope
}

#[test]
fn blocker_syntax_present() {
    let usda = export(&hello_wall());

    // B2: every authored translate MUST be paired 1:1 with an xformOpOrder.
    let translates = usda.matches("double3 xformOp:translate").count();
    let orders = usda.matches("uniform token[] xformOpOrder = [\"xformOp:translate\"]").count();
    assert_eq!(translates, orders, "each xformOp:translate needs its xformOpOrder");

    // B3: every material:binding needs MaterialBindingAPI applied.
    let bindings = usda.matches("rel material:binding").count();
    let applied = usda.matches("prepend apiSchemas = [\"MaterialBindingAPI\"]").count();
    assert!(bindings > 0, "the wall binds a material");
    assert_eq!(bindings, applied, "each bound prim applies MaterialBindingAPI");

    // B4: meshes must opt out of subdivision or authored normals are ignored.
    let meshes = usda.matches("def Mesh \"").count();
    let none = usda.matches("uniform token subdivisionScheme = \"none\"").count();
    assert_eq!(meshes, none, "every mesh sets subdivisionScheme = none");
}

#[test]
fn hierarchy_has_project_and_spatial_chain() {
    let usda = export(&hello_wall());
    for class in ["IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcWall"] {
        assert!(
            usda.contains(&format!("custom string ifc:class = \"{class}\"")),
            "expected an {class} prim",
        );
    }
}

#[test]
fn join_complete_no_mesh_dropped() {
    let bytes = hello_wall();
    let usda = export(&bytes);
    let ids = xform_ids(&scan(&usda));

    let result = process_geometry(&bytes);
    let meshed: HashSet<u32> =
        result.meshes.iter().filter(|m| mesh_emittable(m)).map(|m| m.express_id).collect();
    assert!(!meshed.is_empty(), "fixture has geometry");
    for id in &meshed {
        assert!(ids.contains(id), "meshed element #{id} has no prim (geometry dropped)");
    }
}

/// The strong content assertion: the largest source mesh's exact vertices, normals,
/// indices and placement survive into the stage (catches swapped/mangled arrays, a
/// dropped translate axis, or a wrong placement — none of which substring tests see).
#[test]
fn geometry_content_matches_source() {
    let bytes = hello_wall();
    let usda = export(&bytes);
    let parsed = parse_meshes(&usda);

    // Per-mesh USD invariants (usdchecker would enforce these).
    for m in &parsed {
        assert_eq!(m.points.len(), m.normals.len(), "points/normals length mismatch");
        assert!(m.counts.iter().all(|&c| c == 3), "all faces must be triangles");
        assert_eq!(
            m.counts.iter().sum::<u32>() as usize,
            m.indices.len(),
            "sum(faceVertexCounts) must equal faceVertexIndices length",
        );
        let vc = (m.points.len() / 3) as u32;
        assert!(m.indices.iter().all(|&i| i < vc), "index out of vertex range");
    }

    let result = process_geometry(&bytes);
    let target = result
        .meshes
        .iter()
        .filter(|m| mesh_emittable(m))
        .max_by_key(|m| m.positions.len())
        .expect("a source mesh");

    // fmt_f32 is shortest-round-trip, so re-parsed points equal the source bit-for-bit.
    let hit = parsed
        .iter()
        .find(|pm| pm.points == target.positions)
        .expect("no emitted mesh matches the largest source mesh's vertices");
    assert_eq!(hit.normals, target.normals, "normals must match source");
    assert_eq!(hit.indices, target.indices, "indices must match source");

    if target.origin.iter().any(|v| v.abs() > 0.0) {
        let t = hit.translate.expect("origin-bearing mesh must author a translate");
        for (a, b) in t.iter().zip(target.origin.iter()) {
            assert!((a - b).abs() < 1e-6, "translate must equal origin");
        }
    }
}

#[test]
fn local_points_are_object_scale() {
    // Local (pre-placement) vertices are object-scale, so f32 stays precise even for a
    // georeferenced model — the whole point of carrying origin as a double3 translate.
    for m in parse_meshes(&export(&hello_wall())) {
        for v in m.points {
            assert!(v.abs() < 1.0e4, "local vertex {v} is not object-scale");
        }
    }
}

#[test]
fn deterministic() {
    let bytes = hello_wall();
    assert_eq!(export(&bytes), export(&bytes), "export must be byte-deterministic");
}

#[test]
fn materials_and_properties_present() {
    let usda = export(&hello_wall());
    assert!(usda.contains("def Material \"Mat_"), "a UsdPreviewSurface material");
    assert!(usda.contains("uniform token info:id = \"UsdPreviewSurface\""), "preview surface shader");
    assert!(usda.contains("color3f[] primvars:displayColor = ["), "displayColor fallback");
    assert!(
        usda.contains("custom string ifc:pset:Pset_WallCommon:IsExternal ="),
        "the wall's Pset_WallCommon.IsExternal property survives to a custom attr",
    );
}

#[test]
fn provenance_in_customlayerdata() {
    let usda = export(&hello_wall());
    let header = &usda[..usda.find("\ndef ").expect("a root prim")];
    assert!(header.contains("string generator = \"ifc-lite "), "generator provenance present");
    let marker = "string sourceFingerprint = \"";
    let start = header.find(marker).expect("source fingerprint present") + marker.len();
    let fp = &header[start..start + 16];
    assert!(fp.chars().all(|c| c.is_ascii_hexdigit()), "fingerprint is 16 hex digits, got {fp}");
    // The fingerprint tracks the source: a different input yields a different value.
    let other = b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
    let other_usda = export(other);
    let os = other_usda.find(marker).expect("fp") + marker.len();
    assert_ne!(fp, &other_usda[os..os + 16], "fingerprint must depend on source bytes");
}

/// The text between an `ifc:class = "<class>"` marker and that prim's first `def` child
/// (the element Xform's own attributes, before its meshes/children).
fn xform_attr_block<'a>(usda: &'a str, class: &str) -> Option<&'a str> {
    let pos = usda.find(&format!("ifc:class = \"{class}\""))?;
    let rest = &usda[pos..];
    Some(&rest[..rest.find("def ").unwrap_or(rest.len())])
}

/// The text of an element's whole prim — from its `ifc:class` marker to the next element's
/// `ifc:class` (so it includes the element's own mesh prims).
fn element_block<'a>(usda: &'a str, class: &str) -> Option<&'a str> {
    let pos = usda.find(&format!("ifc:class = \"{class}\""))?;
    let rest = &usda[pos..];
    let end = rest[1..].find("custom string ifc:class = ").map(|i| i + 1).unwrap_or(rest.len());
    Some(&rest[..end])
}

#[test]
fn openings_and_spaces_are_guide_purpose() {
    let usda = export(&hello_wall());
    for class in ["IfcOpeningElement", "IfcSpace"] {
        // guide is authored on the element's MESH, never its Xform — so it can't inherit
        // down to an ordinary element spatially contained in a space.
        let xform = xform_attr_block(&usda, class).unwrap_or_else(|| panic!("{class} present"));
        assert!(
            !xform.contains("purpose ="),
            "{class} Xform must not author purpose (only its mesh does)",
        );
        let block = element_block(&usda, class).unwrap();
        assert!(
            block.contains("uniform token purpose = \"guide\""),
            "{class} mesh must be purpose=guide",
        );
    }
    // Ordinary building elements keep the default (render) purpose everywhere.
    let wall = element_block(&usda, "IfcWall").expect("wall prim");
    assert!(!wall.contains("purpose = \"guide\""), "IfcWall must never be guide");
}

#[test]
fn source_fingerprint_is_stable_fnv1a64() {
    // Canonical FNV-1a-64 vectors — identical on every platform/toolchain (unlike the
    // std DefaultHasher this replaced), so the lineage anchor and the export stay stable.
    assert_eq!(super::emit::source_fingerprint(b""), "cbf29ce484222325");
    assert_eq!(super::emit::source_fingerprint(b"foobar"), "85944171f73967e8");
}

#[test]
fn empty_model_is_safe() {
    // A project-only model (no geometry): valid stage, World prim, no meshes, no panic.
    let ifc = b"ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',$,$,'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCPROJECT('0aaaaaaaaaaaaaaaaaaaaa',$,'Empty',$,$,$,$,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
    let usda = export(ifc);
    assert!(usda.starts_with("#usda 1.0\n(\n"));
    assert!(usda.contains("def Xform \"World\""));
    assert!(!usda.contains("def Mesh \""), "no geometry → no meshes");
    scan(&usda);
}

#[test]
fn type_product_geometry_lands_in_unassigned() {
    // Skip-if-absent: type-only geometry (IfcBoilerType #43) is keyed by the type id,
    // never appears in the spatial tree, so the Unassigned bucket is the only thing
    // keeping it from being dropped. Same fixture model.rs uses for the join.
    let rel =
        "buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-blob-texture.ifc";
    let bytes = fixture_or_skip!(rel);
    let usda = export(&bytes);
    let ids = xform_ids(&scan(&usda));

    let result = process_geometry(&bytes);
    let meshed: Vec<u32> =
        result.meshes.iter().filter(|m| mesh_emittable(m)).map(|m| m.express_id).collect();
    if meshed.is_empty() {
        return;
    }
    assert!(usda.contains("def Xform \"Unassigned\""), "type geometry needs the Unassigned bucket");
    for id in &meshed {
        assert!(ids.contains(id), "type-product mesh #{id} dropped");
    }
}

// ── pure-unit tests (adversarial inputs the clean fixture can't exercise) ─────

#[test]
fn mesh_emittable_rejects_bad_index_and_origin() {
    // Base = a valid single triangle.
    let good = MeshData {
        express_id: 1,
        ifc_type: "IfcWall".into(),
        global_id: None,
        name: None,
        presentation_layer: None,
        positions: vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        normals: vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0],
        indices: vec![0, 1, 2],
        color: [0.5, 0.5, 0.5, 1.0],
        material_name: None,
        geometry_item_id: None,
        properties: None,
        uvs: None,
        texture: None,
        geometry_class: 0,
        origin: [0.0, 0.0, 0.0],
        instance: None,
        local_bounds: None,
        local_to_world: None,
    };
    assert!(mesh_emittable(&good));

    // S1: index buffer not a whole number of triangles.
    let mut bad = good.clone();
    bad.indices = vec![0, 1, 2, 0];
    assert!(!mesh_emittable(&bad), "non-multiple-of-3 index buffer must be rejected");

    // S1: index out of vertex range.
    let mut bad = good.clone();
    bad.indices = vec![0, 1, 9];
    assert!(!mesh_emittable(&bad), "out-of-range index must be rejected");

    // S2: non-finite origin (would silently mislocate the mesh).
    let mut bad = good.clone();
    bad.origin = [f64::NAN, 0.0, 0.0];
    assert!(!mesh_emittable(&bad), "non-finite origin must be rejected");

    // Non-finite coordinate.
    let mut bad = good.clone();
    bad.positions[0] = f32::INFINITY;
    assert!(!mesh_emittable(&bad), "non-finite position must be rejected");
}

#[test]
fn emit_attributes_dedups_colliding_names() {
    // Two property names that sanitize to the same identifier (`Fire_Rating`) must not
    // emit the same attribute spec twice — a duplicate Sdf property spec is a parse error.
    let row = EntityRow {
        express_id: 1,
        ifc_type: "IfcWall".into(),
        global_id: None,
        name: None,
        description: None,
        object_type: None,
        has_geometry: true,
        property_sets: vec![PropertySet {
            name: "Pset_Test".into(),
            properties: vec![
                PropValue { name: "Fire Rating".into(), value: "A".into(), value_type: "IFCLABEL".into() },
                PropValue { name: "Fire-Rating".into(), value: "B".into(), value_type: "IFCLABEL".into() },
            ],
        }],
        quantity_sets: vec![],
        placement: None,
        attributes: vec![],
    };
    let mut out = String::new();
    emit_attributes(&mut out, 1, "IfcWall", Some(&row));
    assert_eq!(
        out.matches("ifc:pset:Pset_Test:Fire_Rating =").count(),
        1,
        "colliding property names must emit exactly once",
    );
}

#[test]
fn escape_str_handles_adversarial() {
    assert_eq!(escape_str(r#"a"b\c"#), r#"a\"b\\c"#);
    assert_eq!(escape_str("line1\nline2\t."), "line1\\nline2\\t.");
    assert_eq!(escape_str("ctrl\u{0007}drop"), "ctrldrop");
}

#[test]
fn sanitize_ident_is_valid() {
    let ok = |s: &str| {
        let mut ch = s.chars();
        let first = ch.next().unwrap();
        (first.is_ascii_alphabetic() || first == '_')
            && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    for (input, fb) in [("Fire Rating", "Prop"), ("2ndFloor", "Prop"), ("", "Prop"), ("é—x", "Prop")]
    {
        assert!(ok(&sanitize_ident(input, fb)), "`{input}` → invalid ident");
    }
}

#[test]
fn number_formatting_never_emits_nan_or_inf() {
    assert_eq!(fmt_f32(f32::NAN), "0");
    assert_eq!(fmt_f32(f32::INFINITY), "0");
    assert_eq!(fmt_f32(-f32::INFINITY), "0");
    assert_eq!(fmt_f32(1.5), "1.5");
    assert_eq!(fmt_f64(f64::NAN), "0");
    assert_eq!(fmt_f64(3.0), "3");
}

#[test]
fn color_key_clamps_out_of_gamut() {
    let key = color_key([-0.1, 2.0, 0.5, f32::NAN]);
    assert_eq!(key, (0, 100, 50, 0));
    let name = mat_name(key);
    assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'), "{name} illegal");
}

#[test]
fn namer_uniquifies() {
    let mut n = Namer::new();
    assert_eq!(n.alloc("geom"), "geom");
    assert_eq!(n.alloc("geom"), "geom_2");
    assert_eq!(n.alloc("geom"), "geom_3");
    n.reserve("Looks");
    assert_eq!(n.alloc("Looks"), "Looks_2");
}

// ── instancing ────────────────────────────────────────────────────────────────

/// Git-tracked synthetic fixture: ONE RepresentationMap instanced by 64 proxies at
/// distinct placements — exercises instancing at scale.
fn synthetic_instances() -> Vec<u8> {
    let path = format!(
        "{}/../geometry/tests/fixtures/mapped_instances_synthetic.ifc",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// Apply a USD row-vector matrix (4 rows, as authored) to a point: `world = (p,1) · M`.
fn apply_usd(rows: &[[f64; 4]; 4], p: [f64; 3]) -> [f64; 3] {
    let h = [p[0], p[1], p[2], 1.0];
    let mut o = [0.0f64; 4];
    for (i, &hi) in h.iter().enumerate() {
        for (j, oj) in o.iter_mut().enumerate() {
            *oj += hi * rows[i][j];
        }
    }
    [o[0] / o[3], o[1] / o[3], o[2] / o[3]]
}

#[test]
fn instancing_emits_prototypes_and_references() {
    for bytes in [hello_wall(), synthetic_instances()] {
        let usda = export_usd(&bytes, &UsdOptions::default());
        assert!(usda.matches("class Mesh \"Proto_").count() >= 1, "expected prototypes");
        assert!(
            usda.matches("prepend references = </World/Prototypes/Proto_").count() >= 1,
            "expected instance references",
        );
        assert!(usda.contains("matrix4d xformOp:transform"), "instance transform");
        let defs = scan(&usda);
        let proto_names: HashSet<&str> = defs
            .iter()
            .filter(|(t, n)| t == "Mesh" && n.starts_with("Proto_"))
            .map(|(_, n)| n.as_str())
            .collect();
        for line in usda.lines() {
            if let Some(rest) =
                line.trim().strip_prefix("prepend references = </World/Prototypes/")
            {
                let name = rest.trim_end_matches('>');
                assert!(proto_names.contains(name), "reference target {name} missing");
            }
        }
    }
}

#[test]
fn prototypes_author_no_xform_ops() {
    // A prototype that authored any xformOp would be silently DROPPED by the referencer's
    // own xformOpOrder (strongest-opinion-wins, wholesale) → misplaced geometry.
    let usda = export(&synthetic_instances());
    let start = usda.find("def Scope \"Prototypes\"").expect("prototypes scope");
    let end = usda[start..].find("\n    }\n").map(|i| i + start).unwrap_or(usda.len());
    assert!(!usda[start..end].contains("xformOp"), "prototype scope authored an xformOp");
}

/// The correctness gate: the authored USD matrix, applied USD-style to the prototype's LOCAL
/// points, reproduces each occurrence's BAKED (instancing-off) world geometry bit-close.
#[test]
fn instance_transform_reconstructs_baked_world() {
    for bytes in [hello_wall(), synthetic_instances()] {
        let on = run_instanced(&bytes);
        assert!(!on.instances.is_empty(), "instancing did not fire");
        let flat = process_geometry(&bytes);

        let mut template: std::collections::HashMap<u32, &MeshData> = Default::default();
        for m in &on.meshes {
            template.entry(m.express_id).or_insert(m);
        }
        let mut baked: std::collections::HashMap<u32, &MeshData> = Default::default();
        for m in &flat.meshes {
            if m.geometry_class == 0 && !m.positions.is_empty() {
                baked.entry(m.express_id).or_insert(m);
            }
        }

        for rec in &on.instances {
            let t = template[&rec.template_express_id];
            let rows = usd_transform_rows(&rec.transform, t.origin)
                .expect("safe instance has an affine transform");
            let occ = baked[&rec.express_id];
            let n = t.positions.len() / 3;
            assert_eq!(n * 3, occ.positions.len(), "template/occurrence vertex count mismatch");
            let mut max_err = 0.0f64;
            for v in 0..n {
                let local =
                    [t.positions[v * 3] as f64, t.positions[v * 3 + 1] as f64, t.positions[v * 3 + 2] as f64];
                let r = apply_usd(&rows, local);
                let w = [
                    occ.origin[0] + occ.positions[v * 3] as f64,
                    occ.origin[1] + occ.positions[v * 3 + 1] as f64,
                    occ.origin[2] + occ.positions[v * 3 + 2] as f64,
                ];
                let e = ((r[0] - w[0]).powi(2) + (r[1] - w[1]).powi(2) + (r[2] - w[2]).powi(2)).sqrt();
                max_err = max_err.max(e);
            }
            assert!(max_err < 1e-4, "instance {} world error {max_err:.3e} m", rec.express_id);
        }
    }
}

#[test]
fn instancing_no_geometry_dropped() {
    let bytes = synthetic_instances();
    let ids = xform_ids(&scan(&export(&bytes)));
    let flat = process_geometry(&bytes);
    let mut expected = HashSet::new();
    for m in flat.meshes.iter().filter(|m| mesh_emittable(m)) {
        expected.insert(m.express_id);
    }
    assert!(!expected.is_empty());
    for id in &expected {
        assert!(ids.contains(id), "occurrence #{id} dropped from instanced stage");
    }
}

#[test]
fn instance_colours_have_materials() {
    // No dangling material:binding — every bound Mat_ prim exists under /World/Looks.
    let usda = export(&synthetic_instances());
    let materials: HashSet<&str> = usda
        .lines()
        .filter_map(|l| l.trim().strip_prefix("def Material \"").and_then(|r| r.strip_suffix('"')))
        .collect();
    let mut bindings = 0;
    for line in usda.lines() {
        if let Some(rest) = line.trim().strip_prefix("rel material:binding = </World/Looks/") {
            let name = rest.trim_end_matches('>');
            assert!(materials.contains(name), "dangling material:binding to {name}");
            bindings += 1;
        }
    }
    assert!(bindings > 0, "expected material bindings");
}

#[test]
fn instancing_disabled_bakes_everything() {
    let bytes = synthetic_instances();
    let usda = export_usd(&bytes, &UsdOptions { instancing: false, ..UsdOptions::default() });
    assert!(!usda.contains("Prototypes"), "instancing:false must not author prototypes");
    assert!(!usda.contains("references ="), "instancing:false must not author references");
    let ids = xform_ids(&scan(&usda));
    let flat = process_geometry(&bytes);
    for m in flat.meshes.iter().filter(|m| mesh_emittable(m)) {
        assert!(ids.contains(&m.express_id), "baked occurrence #{} missing", m.express_id);
    }
}

#[test]
fn instancing_deterministic() {
    let bytes = synthetic_instances();
    assert_eq!(export(&bytes), export(&bytes));
}

#[test]
fn usd_transform_rows_identity_and_translation() {
    let id: [f32; 16] =
        [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    // Identity A, zero origin → identity USD rows.
    assert_eq!(
        usd_transform_rows(&id, [0.0; 3]).unwrap(),
        [[1.0, 0.0, 0.0, 0.0], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]]
    );
    // Identity A, origin (5,2,3) → translation in the LAST row (row-vector convention).
    assert_eq!(usd_transform_rows(&id, [5.0, 2.0, 3.0]).unwrap()[3], [5.0, 2.0, 3.0, 1.0]);
    // A pure translation composes with origin: t = A_trans + A·origin.
    let mut a = id;
    a[3] = 10.0;
    assert_eq!(usd_transform_rows(&a, [5.0, 0.0, 0.0]).unwrap()[3][0], 15.0);
    // Non-finite / projective A are rejected (would misplace geometry).
    let mut nan = id;
    nan[0] = f32::NAN;
    assert!(usd_transform_rows(&nan, [0.0; 3]).is_none());
    let mut proj = id;
    proj[12] = 0.5;
    assert!(usd_transform_rows(&proj, [0.0; 3]).is_none());
}

/// The fallback guard: the id-keyed / one-prototype-per-template emitter can only author an
/// instanced result when every occurrence is unambiguous. Each rejected shape below is a
/// case where authoring would drop or misplace geometry, so `gather` must re-bake instead.
/// No fixture in the corpus exercises these shapes, so this is the only coverage they get.
#[test]
fn instances_authorable_rejects_unrepresentable_shapes() {
    let id: [f32; 16] =
        [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    // Template 7 has one emittable submesh; ids 10/11 are pure occurrences.
    let counts: std::collections::HashMap<u32, usize> = [(7u32, 1usize)].into_iter().collect();

    // Baseline: two distinct occurrences of a clean single-submesh template → authorable.
    assert!(instances_authorable([(10, 7, id), (11, 7, id)], &counts));

    // Blocker 1: two records for the SAME express id (the id-keyed map would drop one).
    assert!(!instances_authorable([(10, 7, id), (10, 7, id)], &counts));

    // Blocker 2: template resolves to >1 emittable submesh → `.first()` is ambiguous.
    let two_sub: std::collections::HashMap<u32, usize> = [(7u32, 2usize)].into_iter().collect();
    assert!(!instances_authorable([(10, 7, id)], &two_sub));
    // …and a template with NO emittable submesh (0) is equally unrepresentable.
    let no_sub: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    assert!(!instances_authorable([(10, 7, id)], &no_sub));

    // Blocker 3: an occurrence id that ALSO owns a full mesh (mixed element) → mesh lost.
    let mixed: std::collections::HashMap<u32, usize> =
        [(7u32, 1usize), (10u32, 1usize)].into_iter().collect();
    assert!(!instances_authorable([(10, 7, id)], &mixed));

    // Non-affine / non-finite transform is rejected regardless of the join being clean.
    let mut proj = id;
    proj[12] = 0.5;
    assert!(!instances_authorable([(10, 7, proj)], &counts));
}

/// A 90°-about-Z rotation exercises the 3×3 LINEAR block — the whole fixture corpus only
/// ever produces identity-orientation instances, so a transpose of rows 0-2 in
/// `usd_transform_rows` (authoring `M` instead of `Mᵀ`, i.e. rotating by `R⁻¹`) would slip
/// past every other green test. Asserts the exact authored rows AND that applying them
/// USD-style reproduces the column-vector rule `occ_world = A·(origin + P)`.
#[test]
fn usd_transform_rows_handles_rotation() {
    // Column-vector A for R_z(90°): x' = -y, y' = x, z' = z (row-major, no translation).
    #[rustfmt::skip]
    let a: [f32; 16] = [
        0.0, -1.0, 0.0, 0.0,
        1.0,  0.0, 0.0, 0.0,
        0.0,  0.0, 1.0, 0.0,
        0.0,  0.0, 0.0, 1.0,
    ];
    let origin = [10.0f64, 20.0, 30.0];
    let rows = usd_transform_rows(&a, origin).expect("affine");
    // USD rows are the COLUMNS of M = A·T(origin): linear = Aᵀ, translation = A·origin.
    assert_eq!(
        rows,
        [
            [0.0, 1.0, 0.0, 0.0],   // ≠ its transpose → catches a linear-block transpose
            [-1.0, 0.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [-20.0, 10.0, 30.0, 1.0], // A·origin = (-oy, ox, oz)
        ]
    );
    // Independent check: authored rows applied USD-style == the baked column-vector world.
    for p in [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.3, -0.7, 2.0]] {
        let got = apply_usd(&rows, p);
        // A·(origin + P): rotate the summed point.
        let s = [origin[0] + p[0], origin[1] + p[1], origin[2] + p[2]];
        let want = [-s[1], s[0], s[2]];
        for (k, (g, w)) in got.iter().zip(want).enumerate() {
            assert!((g - w).abs() < 1e-9, "axis {k}: {got:?} != {want:?}");
        }
    }
}

/// Pull the 16 numbers out of the `matrix4d xformOp:transform = ( .. )` line as a 4×4
/// row-major grid (exactly the order they were authored in).
fn parse_matrix4d(usda: &str) -> [[f64; 4]; 4] {
    let line = usda
        .lines()
        .find(|l| l.contains("matrix4d xformOp:transform"))
        .expect("no matrix4d line");
    let nums: Vec<f64> = line
        .split(['(', ')', ',', '=', ' ', '\t'])
        .filter_map(|t| t.trim().parse::<f64>().ok())
        .collect();
    assert_eq!(nums.len(), 16, "matrix4d must have 16 components, got {}", nums.len());
    let mut m = [[0.0f64; 4]; 4];
    for (k, &v) in nums.iter().enumerate() {
        m[k / 4][k % 4] = v;
    }
    m
}

/// Serialization gate: the `matrix4d` TEXT that `emit_instance_occurrence` writes must
/// decode back — byte-for-byte via shortest-round-trip `fmt_f64` — to the exact rows
/// `usd_transform_rows` produced. The reconstruction test feeds `usd_transform_rows`
/// output straight into `apply_usd`, so a transpose / row-swap / lossy-format bug in the
/// emitter itself would slip past it; this closes that hole. `A` is deliberately
/// asymmetric (a transpose would move numbers) with a non-zero translation column and a
/// non-zero `origin` (so the `A·T(origin)` composition is exercised in the printed text).
#[test]
fn emitted_matrix4d_roundtrips_usd_transform_rows() {
    #[rustfmt::skip]
    let a: [f32; 16] = [
        2.0, 3.0, 0.0, 7.0,
        0.0, 1.0, 5.0, 8.0,
        4.0, 0.0, 1.0, 9.0,
        0.0, 0.0, 0.0, 1.0,
    ];
    let origin = [10.0f64, 20.0, 30.0];
    let expected = usd_transform_rows(&a, origin).expect("affine transform");

    let rec = InstanceRecord {
        express_id: 42,
        ifc_type: "IfcFlowFitting".to_string(),
        global_id: None,
        name: None,
        presentation_layer: None,
        color: [0.5, 0.5, 0.5, 1.0],
        template_express_id: 7,
        rep_identity: 0,
        transform: a,
    };
    let mut origins = std::collections::HashMap::new();
    origins.insert(7u32, origin);

    let mut out = String::new();
    emit_instance_occurrence(&mut out, 3, "geom", &rec, &origins, None);

    // Exact equality: fmt_f64 is shortest-round-trip, so re-parsing is lossless.
    assert_eq!(parse_matrix4d(&out), expected, "emitted matrix4d text != authored rows");
    // Structural sanity independent of the value check: affine → last column (0,0,0,1),
    // translation lives in the LAST row (row-vector convention), never a stray transpose.
    let m = parse_matrix4d(&out);
    for (r, row) in m.iter().enumerate() {
        assert_eq!(row[3], if r == 3 { 1.0 } else { 0.0 }, "row {r} last component");
    }
    assert_eq!([m[3][0], m[3][1], m[3][2]], [expected[3][0], expected[3][1], expected[3][2]]);
}
