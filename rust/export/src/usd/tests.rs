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
use super::{export_usd, mesh_emittable, UsdOptions};
use crate::model::{EntityRow, PropValue, PropertySet};
use ifc_lite_processing::{process_geometry, MeshData};
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

/// `def <Type> "<name>"` → `(Type, name)`, else None.
fn def_of(trimmed: &str) -> Option<(String, String)> {
    let rest = trimmed.strip_prefix("def ")?;
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
    let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("skipping {rel}: fixture absent — run `pnpm fixtures`");
        return;
    };
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
