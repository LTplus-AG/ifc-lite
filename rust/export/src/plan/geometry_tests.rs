// SPDX-License-Identifier: MPL-2.0
//! The geometry patch, end to end through `execute`, read back from the
//! output text and through the geometry engine.

use std::collections::{HashMap, HashSet};

use ifc_lite_core::EntityScanner;

use crate::plan::attrs::attribute_index;
use crate::plan::execute;
use crate::plan::index::parse_attrs;
use crate::plan::test_fixtures::{products_with_geometry, two_walls_sharing_a_pset};
use crate::plan::types::*;

const SCHEMAS: [&str; 3] = ["IFC2X3", "IFC4", "IFC4X3"];

/// A closed, outward-facing tetrahedron.
fn tetrahedron() -> TriangleMesh {
    TriangleMesh {
        positions: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        triangles: vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]],
    }
}

fn geometry(id: u32, mesh: TriangleMesh, colour: Option<SurfaceColour>) -> (ObjectRef, Disposition) {
    (
        ObjectRef::Id(id),
        Disposition::Patch(Patch { geometry: Some(GeometryPatch { mesh, colour }), ..Default::default() }),
    )
}

fn run(source: &[u8], dispositions: Vec<(ObjectRef, Disposition)>) -> (Vec<u8>, WriteReport) {
    let plan = ExportPlan { dispositions, context: PlanContext::attributed() };
    let mut out = Vec::new();
    let report = execute(source, &plan, &mut out).expect("execute");
    (out, report)
}

/// `id -> (UPPERCASE type, record text)`.
fn records(content: &[u8]) -> HashMap<u32, (String, String)> {
    let mut out = HashMap::new();
    let mut scanner = EntityScanner::new(content);
    while let Some((id, t, s, e)) = scanner.next_entity() {
        out.insert(id, (t.to_ascii_uppercase(), String::from_utf8_lossy(&content[s..e]).trim_end().to_string()));
    }
    out
}

fn slot_ref(schema: &str, rec: &(String, String), attr: &str) -> Option<u32> {
    let idx = attribute_index(schema, &rec.0, attr)?;
    parse_attrs(&rec.1)?.get(idx)?.scalar
}

fn slot_list(schema: &str, rec: &(String, String), attr: &str) -> Vec<u32> {
    let idx = attribute_index(schema, &rec.0, attr).unwrap_or_else(|| panic!("{} has no {attr}", rec.0));
    parse_attrs(&rec.1).unwrap()[idx].list.clone().unwrap_or_default().into_iter().flatten().collect()
}

/// The product's body as the output has it: `(shape, representation, item)`.
fn body_of(schema: &str, after: &HashMap<u32, (String, String)>, product: u32) -> (u32, u32, u32) {
    let shape = slot_ref(schema, &after[&product], "Representation").expect("a Representation");
    let reps = slot_list(schema, &after[&shape], "Representations");
    assert_eq!(reps.len(), 1, "{schema}: one representation, the body");
    let rep = &after[&reps[0]];
    assert!(rep.1.contains("'Body'"), "{schema}: {}", rep.1);
    let items = slot_list(schema, rep, "Items");
    assert_eq!(items.len(), 1, "{schema}: one item");
    (shape, reps[0], items[0])
}

/// Triangles in the item: `CoordIndex` entries, or a brep's faces.
fn triangle_count(schema: &str, after: &HashMap<u32, (String, String)>, item: u32) -> usize {
    let rec = &after[&item];
    match rec.0.as_str() {
        "IFCTRIANGULATEDFACESET" => {
            let idx = attribute_index(schema, "IFCTRIANGULATEDFACESET", "CoordIndex").unwrap();
            let text = crate::step_text::attribute_of(&rec.1, idx).unwrap();
            text.matches('(').count() - 1
        }
        "IFCFACETEDBREP" => {
            let shell = slot_ref(schema, rec, "Outer").unwrap();
            slot_list(schema, &after[&shell], "CfsFaces").len()
        }
        other => panic!("{schema}: unexpected body item {other}"),
    }
}

/// Every source record that is neither gone nor in `edited` is written
/// byte for byte as the source had it.
fn assert_untouched(schema: &str, before: &HashMap<u32, (String, String)>, after: &HashMap<u32, (String, String)>, edited: &[u32]) {
    for (id, rec) in before {
        if edited.contains(id) {
            continue;
        }
        if let Some(out) = after.get(id) {
            assert_eq!(out.1, rec.1, "{schema}: #{id} changed");
        }
    }
}

#[test]
fn a_product_gets_a_new_tessellated_body_and_its_old_shape_is_pruned() {
    let colour = SurfaceColour { rgb: [0.8, 0.2, 0.1], transparency: 0.0 };
    for schema in SCHEMAS {
        let source = products_with_geometry(schema);
        let (out, report) = run(&source, vec![geometry(10, tetrahedron(), Some(colour))]);
        assert!(report.refusals.is_empty(), "{schema}: {:?}", report.refusals);
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        assert_eq!(report.patched, 1, "{schema}");
        assert_eq!(
            report.dropped_representations,
            vec![DroppedRepresentation { object: ObjectRef::Id(10), representation: 62, identifier: Some("Axis".into()) }],
            "{schema}"
        );

        let before = records(&source);
        let after = records(&out);
        let (_, rep, item) = body_of(schema, &after, 10);
        let expected = if schema == "IFC2X3" { "IFCFACETEDBREP" } else { "IFCTRIANGULATEDFACESET" };
        assert_eq!(after[&item].0, expected, "{schema}");
        assert_eq!(triangle_count(schema, &after, item), 4, "{schema}");
        assert_eq!(slot_ref(schema, &after[&rep], "ContextOfItems"), Some(103), "{schema}: the file's Body subcontext");
        assert!(
            after.values().any(|r| r.0 == "IFCSTYLEDITEM" && slot_ref(schema, r, "Item") == Some(item)),
            "{schema}: the new item is styled"
        );

        let mut gone = vec![60, 61, 62, 63, 67, 68, 69, 73, 74, 75, 83];
        if schema == "IFC2X3" {
            gone.push(70);
        }
        for id in &gone {
            assert!(!after.contains_key(id), "{schema}: #{id} should be pruned");
        }
        // Shared with wall 11 or the type, or file configuration.
        for id in [64, 65, 66, 72, 76, 78, 79, 80, 81, 82, 90, 91, 92, 93, 100, 102, 103, 104] {
            assert!(after.contains_key(&id), "{schema}: #{id} is still used and must survive");
        }
        assert_eq!(slot_list(schema, &after[&80], "AssignedItems"), vec![91], "{schema}: layer keeps wall 11's body only");
        // The opening and its relationship are not touched.
        for id in [95, 96, 97, 98] {
            assert_eq!(after[&id].1, before[&id].1, "{schema}: #{id}");
        }
        assert_untouched(schema, &before, &after, &[10, 80]);
        assert_eq!(report.deleted, gone.len(), "{schema}: exactly the old shape's own records");
    }
}

#[test]
fn a_type_mapped_body_is_replaced_and_the_type_map_is_kept() {
    for schema in SCHEMAS {
        let source = products_with_geometry(schema);
        let (out, report) = run(&source, vec![geometry(12, tetrahedron(), None)]);
        assert!(report.refusals.is_empty() && report.findings.is_empty(), "{schema}: {:?} {:?}", report.refusals, report.findings);
        assert!(report.dropped_representations.is_empty(), "{schema}");
        let before = records(&source);
        let after = records(&out);
        let (_, _, item) = body_of(schema, &after, 12);
        assert_eq!(triangle_count(schema, &after, item), 4, "{schema}");
        for id in [110, 111, 112] {
            assert!(!after.contains_key(&id), "{schema}: #{id} was wall 12's alone");
        }
        for id in [113, 114, 115, 116, 117, 118, 119, 120, 130, 131, 132] {
            assert!(after.contains_key(&id), "{schema}: #{id} belongs to the type or wall 13");
        }
        assert_untouched(schema, &before, &after, &[12]);
    }
}

#[test]
fn a_product_without_a_shape_gets_one() {
    for schema in SCHEMAS {
        let source = products_with_geometry(schema);
        let (out, report) = run(&source, vec![geometry(14, tetrahedron(), None)]);
        assert!(report.refusals.is_empty() && report.findings.is_empty(), "{schema}: {:?} {:?}", report.refusals, report.findings);
        assert_eq!(report.deleted, 0, "{schema}");
        let after = records(&out);
        body_of(schema, &after, 14);
        assert_untouched(schema, &records(&source), &after, &[14]);
    }
}

#[test]
fn a_shape_two_products_share_is_released_only_when_both_are_replaced() {
    for schema in SCHEMAS {
        let source = String::from_utf8(products_with_geometry(schema)).unwrap();
        // Wall 11 names wall 10's shape; its own (#90 and below) is left
        // unreferenced in the source, and is not this patch's to prune.
        let wall11 = source.lines().find(|l| l.starts_with("#11=")).unwrap();
        let source = source.replace(wall11, &wall11.replace("#90", "#60")).into_bytes();

        let (out, report) = run(&source, vec![geometry(10, tetrahedron(), None)]);
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        assert_eq!(report.deleted, 0, "{schema}: wall 11 still uses all of #60");
        let after = records(&out);
        assert_eq!(slot_ref(schema, &after[&11], "Representation"), Some(60), "{schema}");

        let (out, report) = run(&source, vec![geometry(10, tetrahedron(), None), geometry(11, tetrahedron(), None)]);
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        let after = records(&out);
        for id in [60, 61, 62, 63, 69, 73] {
            assert!(!after.contains_key(&id), "{schema}: #{id} is released by both walls together");
        }
        assert!(after.contains_key(&90), "{schema}: an orphan already in the source is not swept");
    }
}

/// Wall 11 is deleted and wall 10 gets a new body in one plan: the solid
/// both bodies listed goes. Wall 11's body is taken off layer `#80` first:
/// delete's own cascade counts a layer entry as a use and would keep it.
#[test]
fn a_delete_and_a_geometry_patch_release_shared_records_together() {
    for schema in SCHEMAS {
        let source = String::from_utf8(products_with_geometry(schema)).unwrap().replace("(#61,#62,#91)", "(#61,#62)").into_bytes();
        let (out, report) = run(&source, vec![(ObjectRef::Id(11), Disposition::Delete), geometry(10, tetrahedron(), None)]);
        assert!(report.refusals.is_empty() && report.findings.is_empty(), "{schema}: {:?} {:?}", report.refusals, report.findings);
        let after = records(&out);
        for id in [11, 60, 61, 62, 76, 80, 81, 82, 90, 91] {
            assert!(!after.contains_key(&id), "{schema}: #{id}");
        }
        assert!(after.contains_key(&64), "{schema}: the profile wall 11's solid still uses");
    }
}

#[test]
fn a_file_without_a_context_gets_one_attached_to_its_project() {
    for schema in SCHEMAS {
        let source = String::from_utf8(two_walls_sharing_a_pset(schema)).unwrap();
        let source = source
            .lines()
            .filter(|l| !l.starts_with("#100=") && !l.starts_with("#101=") && !l.starts_with("#102="))
            .map(|l| if l.starts_with("#1=") { l.replace("(#100)", "$") } else { l.to_string() })
            .collect::<Vec<_>>()
            .join("\n");
        let (out, report) = run(source.as_bytes(), vec![geometry(10, tetrahedron(), None), geometry(11, tetrahedron(), None)]);
        assert!(report.refusals.is_empty() && report.findings.is_empty(), "{schema}: {:?} {:?}", report.refusals, report.findings);
        let after = records(&out);
        let contexts: Vec<u32> = after.iter().filter(|(_, r)| r.0 == "IFCGEOMETRICREPRESENTATIONCONTEXT").map(|(&id, _)| id).collect();
        assert_eq!(contexts.len(), 1, "{schema}: synthesized once, shared");
        assert_eq!(slot_list(schema, &after[&1], "RepresentationContexts"), contexts, "{schema}");
        for wall in [10, 11] {
            let (_, rep, _) = body_of(schema, &after, wall);
            assert_eq!(slot_ref(schema, &after[&rep], "ContextOfItems"), Some(contexts[0]), "{schema}");
        }
    }
}

#[test]
fn an_open_ifc2x3_mesh_is_a_surface_model() {
    let mut open = tetrahedron();
    open.triangles.pop();
    let (out, report) = run(&products_with_geometry("IFC2X3"), vec![geometry(10, open, None)]);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    let after = records(&out);
    let shape = slot_ref("IFC2X3", &after[&10], "Representation").unwrap();
    let rep = slot_list("IFC2X3", &after[&shape], "Representations")[0];
    let item = slot_list("IFC2X3", &after[&rep], "Items")[0];
    assert_eq!(after[&item].0, "IFCSHELLBASEDSURFACEMODEL");
}

#[test]
fn geometry_that_cannot_be_written_or_placed_is_refused_and_writes_nothing() {
    let source = products_with_geometry("IFC4");
    let (preserved, _) = run(&source, vec![(ObjectRef::Id(10), Disposition::Preserve)]);
    let cases: Vec<(u32, TriangleMesh, Option<SurfaceColour>, &str)> = vec![
        (10, TriangleMesh { positions: vec![[0.0; 3]; 3], triangles: vec![[0, 1, 3]] }, None, "indexes past"),
        (10, TriangleMesh { positions: vec![[0.0; 3]; 3], triangles: vec![[0, 1, 1]] }, None, "repeats a vertex"),
        (10, TriangleMesh { positions: vec![[0.0; 3]; 3], triangles: vec![] }, None, "at least one triangle"),
        (10, TriangleMesh { positions: vec![[f64::NAN, 0.0, 0.0], [1.0; 3], [2.0; 3]], triangles: vec![[0, 1, 2]] }, None, "not finite"),
        (10, tetrahedron(), Some(SurfaceColour { rgb: [1.5, 0.0, 0.0], transparency: 0.0 }), "0..1"),
        (120, tetrahedron(), None, "no Representation attribute"),
    ];
    for (id, mesh, colour, expect) in cases {
        let (out, report) = run(&source, vec![geometry(id, mesh, colour)]);
        assert_eq!(report.refusals.len(), 1, "{expect}");
        assert!(report.refusals[0].reason.contains(expect), "{expect}: {:?}", report.refusals);
        assert_eq!(out, preserved, "{expect}: a refused geometry patch writes nothing");
    }
}

/// The geometry engine meshes the new body at the wall's placement, in the
/// requested colour, in every schema.
#[test]
fn the_engine_meshes_the_new_body_in_its_colour() {
    let colour = SurfaceColour { rgb: [0.8, 0.2, 0.1], transparency: 0.0 };
    let big = TriangleMesh { positions: tetrahedron().positions.iter().map(|p| [p[0] * 2.0, p[1] * 3.0, p[2] * 4.0]).collect(), ..tetrahedron() };
    for schema in SCHEMAS {
        let (out, report) = run(&products_with_geometry(schema), vec![geometry(10, big.clone(), Some(colour))]);
        assert!(report.findings.is_empty(), "{schema}: {:?}", report.findings);
        let result = ifc_lite_processing::process_geometry(&out);
        let mesh = result.meshes.iter().find(|m| m.express_id == 10).unwrap_or_else(|| panic!("{schema}: wall 10 not meshed"));
        assert_eq!(mesh.indices.len(), 12, "{schema}: 4 triangles");
        let mut extent: Vec<f64> = (0..3)
            .map(|axis| {
                let vals = mesh.positions.iter().skip(axis).step_by(3);
                let (lo, hi) = vals.fold((f32::MAX, f32::MIN), |(lo, hi), &v| (lo.min(v), hi.max(v)));
                f64::from(hi - lo)
            })
            .collect();
        extent.sort_by(f64::total_cmp);
        for (got, want) in extent.iter().zip([2.0, 3.0, 4.0]) {
            assert!((got - want).abs() < 1e-4, "{schema}: extent {extent:?}");
        }
        let [r, g, b, _] = mesh.color;
        assert!((r - 0.8).abs() < 1e-3 && (g - 0.2).abs() < 1e-3 && (b - 0.1).abs() < 1e-3, "{schema}: colour {:?}", mesh.color);
    }
}

#[test]
fn the_same_geometry_plan_writes_the_same_bytes_twice() {
    let source = products_with_geometry("IFC4");
    let plan = || vec![geometry(10, tetrahedron(), None), geometry(12, tetrahedron(), None)];
    assert_eq!(run(&source, plan()).0, run(&source, plan()).0);
}

/// Every record the old shape reaches and nothing else can reach is gone;
/// nothing still reachable from a surviving record is.
#[test]
fn no_record_the_old_shape_alone_reached_survives() {
    for schema in SCHEMAS {
        let source = products_with_geometry(schema);
        let (out, _) = run(&source, vec![geometry(10, tetrahedron(), None)]);
        let after = records(&out);
        // Everything in the output is reachable from a root: a product, a
        // relationship, a type, the project, a layer or a context.
        let roots: Vec<u32> = after
            .iter()
            .filter(|(_, r)| {
                r.0 == "IFCWALL"
                    || r.0 == "IFCOPENINGELEMENT"
                    || r.0 == "IFCWALLTYPE"
                    || r.0 == "IFCPROJECT"
                    || r.0.starts_with("IFCREL")
                    || r.0 == "IFCPRESENTATIONLAYERASSIGNMENT"
                    || r.0 == "IFCSTYLEDITEM"
                    || r.0.contains("CONTEXT")
            })
            .map(|(&id, _)| id)
            .collect();
        let mut seen: HashSet<u32> = HashSet::new();
        let mut stack = roots;
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            let mut refs = Vec::new();
            crate::step_text::refs_in_line(after[&id].1.as_bytes(), &mut refs);
            stack.extend(refs.into_iter().filter(|r| after.contains_key(r)));
        }
        let unreachable: Vec<u32> = after.keys().copied().filter(|id| !seen.contains(id)).collect();
        assert!(unreachable.is_empty(), "{schema}: unreferenced records left behind: {unreachable:?}");
    }
}

/// A styled item that an `IfcStyledRepresentation` lists is part of that
/// representation: replacing the body leaves it, rather than emptying the
/// representation's `Items`.
#[test]
fn a_styled_item_a_styled_representation_lists_is_kept() {
    let source = String::from_utf8(products_with_geometry("IFC4")).unwrap().replace(
        "#60=IFCPRODUCTDEFINITIONSHAPE",
        "#145=IFCSTYLEDREPRESENTATION(#100,$,$,(#69));\n#146=IFCMATERIALDEFINITIONREPRESENTATION($,$,(#145),#147);\n#147=IFCMATERIAL('M',$,$);\n#60=IFCPRODUCTDEFINITIONSHAPE",
    );
    assert!(source.contains("#145=IFCSTYLEDREPRESENTATION"), "fixture");
    let (out, report) = run(source.as_bytes(), vec![geometry(10, tetrahedron(), None)]);
    let after = records(&out);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    assert!(after.get(&145).is_some_and(|r| r.1.contains("(#69)")), "{:?}", after.get(&145));
    assert!(after.contains_key(&69));
}

/// A triangle without area (coincident or collinear corners) is refused.
#[test]
fn a_triangle_without_area_is_refused() {
    for schema in SCHEMAS {
        for positions in [
            vec![[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
            vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [2.0, 0.0, 0.0]],
        ] {
            let mesh = TriangleMesh { positions, triangles: vec![[0, 1, 2]] };
            let (_, report) = run(&products_with_geometry(schema), vec![geometry(10, mesh, None)]);
            assert_eq!(report.refusals.len(), 1, "{schema}");
        }
    }
}

/// One triangle written twice, wound both ways, uses every edge twice and
/// encloses nothing: it is not written as a solid.
#[test]
fn a_sheet_written_twice_is_not_a_solid() {
    for schema in SCHEMAS {
        let mesh = TriangleMesh { positions: vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]], triangles: vec![[0, 1, 2], [0, 2, 1]] };
        let (out, _) = run(&products_with_geometry(schema), vec![geometry(10, mesh, None)]);
        let text = String::from_utf8_lossy(&out);
        let item = text.lines().find(|l| l.contains("IFCFACETEDBREP") || l.contains("IFCTRIANGULATEDFACESET(") || l.contains("IFCSHELLBASEDSURFACEMODEL")).unwrap();
        assert!(!item.contains("IFCFACETEDBREP") && !item.contains(",.T.,"), "{schema}: {item}");
    }
}

/// A closed mesh far from the origin is still a solid: closedness is
/// measured against the mesh's own size.
#[test]
fn a_closed_mesh_far_from_the_origin_is_a_solid() {
    let mut mesh = tetrahedron();
    for p in &mut mesh.positions {
        p[0] += 1.0e6;
    }
    let (out, _) = run(&products_with_geometry("IFC2X3"), vec![geometry(10, mesh, None)]);
    assert!(String::from_utf8_lossy(&out).contains("IFCFACETEDBREP"));
}

/// With only a 2D `Plan` context in the file, a 3D body gets a context of its
/// own rather than landing in the plan.
#[test]
fn a_body_never_lands_in_a_two_dimensional_context() {
    let schema = "IFC4";
    let source: String = String::from_utf8(products_with_geometry(schema))
        .unwrap()
        .lines()
        .filter(|l| !l.starts_with("#103=") && !l.starts_with("#104="))
        .map(|l| if l.starts_with("#100=") { l.replace("'Model',3", "'Plan',2") } else { l.to_string() })
        .collect::<Vec<_>>()
        .join("\n");
    assert!(source.contains("'Plan',2"), "fixture");
    let (out, _) = run(source.as_bytes(), vec![geometry(14, tetrahedron(), None)]);
    let after = records(&out);
    let (_, rep, _) = body_of(schema, &after, 14);
    let ctx = slot_ref(schema, &after[&rep], "ContextOfItems").unwrap();
    assert!(!after[&ctx].1.contains("'Plan'"), "{}", after[&ctx].1);
}

/// Two patches giving one product a body: the first applies, the second is
/// refused, and nothing is left unreferenced.
#[test]
fn a_second_body_for_the_same_product_is_refused() {
    for schema in SCHEMAS {
        let source = products_with_geometry(schema);
        let plan = ExportPlan { dispositions: vec![geometry(10, tetrahedron(), None), geometry(10, tetrahedron(), None)], context: PlanContext::attributed() };
        let mut out = Vec::new();
        let report = execute(&source, &plan, &mut out).unwrap();
        assert_eq!(report.refusals.len(), 1, "{schema}: {:?}", report.refusals);
        let single = ExportPlan { dispositions: vec![geometry(10, tetrahedron(), None)], context: PlanContext::attributed() };
        let mut once = Vec::new();
        execute(&source, &single, &mut once).unwrap();
        assert_eq!(out, once, "{schema}: the same output as one patch");
    }
}

/// A shape aspect naming the old shape and its Body representation goes with
/// the shape, and so does the representation it alone kept.
#[test]
fn a_shape_aspect_does_not_keep_the_old_body() {
    let schema = "IFC4";
    let aspect = "#140=IFCSHAPEASPECT((#62),'Part',$,.T.,#60);\n";
    let source = String::from_utf8(products_with_geometry(schema)).unwrap().replace("ENDSEC;\nEND-ISO", &format!("{aspect}ENDSEC;\nEND-ISO"));
    assert!(source.contains("#140="));
    let (out, report) = run(source.as_bytes(), vec![geometry(10, tetrahedron(), None)]);
    assert!(report.findings.is_empty(), "{:?}", report.findings);
    let after = records(&out);
    assert!(!after.contains_key(&140), "the aspect goes with the shape");
    assert!(!after.contains_key(&62), "the Axis representation it named goes too");
}

/// A 2D `Model` context is not a body's context: a file with only that gets
/// a 3D one.
#[test]
fn a_two_dimensional_model_context_is_not_chosen() {
    let schema = "IFC4";
    let source = String::from_utf8(two_walls_sharing_a_pset(schema)).unwrap().replace("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,", "IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',2,");
    let index = crate::plan::index::FileIndex::complete(source.as_bytes());
    assert_eq!(crate::plan::tessellation::find_body_context(&index, schema, &HashSet::new()), None);
}

/// A `Body` subcontext of a 2D context is not a body's context either
/// (#8079 review).
#[test]
fn a_body_subcontext_of_a_two_dimensional_context_is_not_chosen() {
    let schema = "IFC4";
    let source = String::from_utf8(products_with_geometry(schema))
        .unwrap()
        .replace("IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,", "IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',2,");
    let index = crate::plan::index::FileIndex::complete(source.as_bytes());
    assert_eq!(crate::plan::tessellation::find_body_context(&index, schema, &HashSet::new()), None);
}
