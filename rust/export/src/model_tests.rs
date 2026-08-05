// SPDX-License-Identifier: MPL-2.0
//! Tests for `model.rs`, split out under the house pattern (AGENTS.md).
//!
//! `model.rs` sits on the module-size ratchet's allowlist at its recorded
//! budget, and the ratchet counts non-test lines — so tests that grow with the
//! module have to live beside it rather than inside it.

use super::*;
use std::sync::Arc;

fn fixture(rel: &str) -> Vec<u8> {
    let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

/// Skip-if-absent loader (test models are staged, not git-tracked). Only a
/// genuinely-missing file is a skip; any other read error (permission, I/O)
/// fails the test rather than passing as a false green.
fn fixture_opt(rel: &str) -> Option<Vec<u8>> {
    let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
    match std::fs::read(&path) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!("skipping {rel}: fixture absent — run `pnpm fixtures`");
            None
        }
        Err(e) => panic!("read {path}: {e}"),
    }
}

/// #1518: a buildingSMART annex-E showcase file declares its geometry ONLY on
/// an `IfcBoilerType` (an IfcTypeProduct, not an IfcProduct). #957 Route B
/// meshes it under the type's expressId; the attribute pass must now emit a
/// matching row so the GLB node is not orphaned (renders with attributes).
#[test]
fn type_only_geometry_emits_attribute_row() {
    let rel =
        "buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-blob-texture.ifc";
    let Some(bytes) = fixture_opt(rel) else {
        return;
    };
    let mut rows = Vec::new();
    stream_export_model(&bytes, |r| rows.push(r));

    // The type-object is #43 IFCBOILERTYPE('2n5ASfQfT84eP9h$zLLJ4A','Boiler'…).
    let boiler = rows
        .iter()
        .find(|r| r.ifc_type == "IfcBoilerType")
        .expect("IfcBoilerType must get an attribute row (was orphaned pre-#1518)");
    assert_eq!(boiler.express_id, 43, "row keyed by the type's expressId");
    assert_eq!(boiler.global_id.as_deref(), Some("2n5ASfQfT84eP9h$zLLJ4A"));
    assert_eq!(boiler.name.as_deref(), Some("Boiler"));
    assert!(boiler.has_geometry, "the type carries RepresentationMaps");

    // build == stream still holds with type rows present.
    let collected = build_export_model(&bytes).entities;
    assert_eq!(collected, rows, "build and stream must agree with type rows");
}

/// The adversarial join test: EVERY mesh the geometry pass tags as
/// type-product geometry (geometry_class != 0, keyed by the type's expressId)
/// must have a matching attribute row of the same type. This is exactly the
/// downstream geometry-to-attribute join the #1518 gap broke; it must hold for
/// the whole showcase set.
#[test]
fn type_product_meshes_all_have_rows() {
    for rel in [
        "buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-blob-texture.ifc",
        "buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-image-texture.ifc",
        "buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-pixel-texture.ifc",
    ] {
        let Some(bytes) = fixture_opt(rel) else {
            continue;
        };
        let result = ifc_lite_processing::process_geometry(&bytes);
        // (express_id, ifc_type) for every meshed type-product node.
        let mut type_meshes: Vec<(u32, String)> = result
            .meshes
            .iter()
            .filter(|m| m.geometry_class != 0)
            .map(|m| (m.express_id, m.ifc_type.clone()))
            .collect();
        type_meshes.sort();
        type_meshes.dedup();
        if type_meshes.is_empty() {
            continue; // no orphan type geometry in this fixture
        }

        let mut rows = Vec::new();
        stream_export_model(&bytes, |r| rows.push(r));
        for (id, ty) in &type_meshes {
            let row = rows.iter().find(|r| r.express_id == *id).unwrap_or_else(|| {
                panic!("{rel}: meshed type-product #{id} ({ty}) has no attribute row")
            });
            assert_eq!(&row.ifc_type, ty, "{rel}: #{id} row type must match its mesh");
        }
    }
}

#[test]
fn duplex_model_has_products_and_psets() {
    let model = build_export_model(&fixture("ara3d/duplex.ifc"));
    assert!(model.entities.len() > 50, "expected many products, got {}", model.entities.len());

    // Every row carries a GlobalId + type.
    for e in &model.entities {
        assert!(!e.ifc_type.is_empty());
    }
    assert!(model.entities.iter().any(|e| e.global_id.is_some()), "some GlobalIds");

    // At least one element carries property sets with named single values.
    let with_psets = model.entities.iter().filter(|e| !e.property_sets.is_empty()).count();
    assert!(with_psets > 0, "expected elements with property sets");
    let any_prop = model
        .entities
        .iter()
        .flat_map(|e| &e.property_sets)
        .flat_map(|ps| &ps.properties)
        .next();
    let p = any_prop.expect("at least one property");
    assert!(!p.name.is_empty() && !p.value_type.is_empty());
}

#[test]
fn stream_matches_build_row_for_row() {
    // `build_export_model` is a `collect` over `stream_export_model`, so the
    // two must agree byte-for-byte, in the same order, on the same input.
    // Guards against the streaming path ever drifting from the collected one.
    let rel = "ara3d/duplex.ifc";
    let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
    if !std::path::Path::new(&path).exists() {
        eprintln!("skipping {rel}: fixture absent — run `pnpm fixtures`");
        return;
    }
    let bytes = fixture(rel);
    let collected = build_export_model(&bytes).entities;
    let mut streamed = Vec::new();
    stream_export_model(&bytes, |r| streamed.push(r));
    assert!(!streamed.is_empty(), "expected products");
    assert_eq!(collected, streamed, "stream and collect must agree row-for-row");
}

#[test]
fn stream_with_index_matches_plain() {
    // The injected-index path shares one index across passes; it must yield
    // identical rows to the self-indexing path. Guards the two from drifting.
    let rel = "ara3d/duplex.ifc";
    let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
    if !std::path::Path::new(&path).exists() {
        eprintln!("skipping {rel}: fixture absent — run `pnpm fixtures`");
        return;
    }
    let bytes = fixture(rel);
    let mut plain = Vec::new();
    stream_export_model(&bytes, |r| plain.push(r));
    let idx = Arc::new(ifc_lite_core::build_entity_index(&bytes));
    let mut shared = Vec::new();
    stream_export_model_with_index(&bytes, &idx, |r| shared.push(r));
    assert!(!plain.is_empty(), "expected products");
    assert_eq!(plain, shared, "injected-index rows must match self-indexed rows");
}

#[test]
fn fmt_num_is_clean() {
    assert_eq!(fmt_num(1.0), "1");
    assert_eq!(fmt_num(1.5), "1.5");
    assert_eq!(fmt_num(2.500000), "2.5");
    assert_eq!(fmt_num(0.0), "0");
}

/// A 22-character IFC GlobalId, padded from a readable tag. Synthetic: these
/// files are written here, not sampled from anywhere.
fn gid(tag: &str) -> String {
    let mut s = tag.to_string();
    while s.len() < 22 {
        s.push('0');
    }
    s
}

/// The smallest file that carries a dimensional attribute: one wall, one
/// `Qto_WallBaseQuantities.Length` of 3000, and a declared length unit.
fn wall_with_length(prefix: &str) -> String {
    format!(
        "ISO-10303-21;\n\
         HEADER;\n\
         FILE_DESCRIPTION((''),'');\n\
         FILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\n\
         ENDSEC;\n\
         DATA;\n\
         #1=IFCSIUNIT(*,.LENGTHUNIT.,{prefix},.METRE.);\n\
         #2=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);\n\
         #3=IFCUNITASSIGNMENT((#1,#2));\n\
         #4=IFCPROJECT('{proj}',$,'P',$,$,$,$,$,#3);\n\
         #5=IFCWALL('{wall}',$,'W',$,$,$,$,$,$);\n\
         #6=IFCQUANTITYLENGTH('Length',$,$,3000.,$);\n\
         #7=IFCELEMENTQUANTITY('{qto}',$,'Qto_WallBaseQuantities',$,$,(#6));\n\
         #8=IFCRELDEFINESBYPROPERTIES('{rel}',$,$,$,(#5),#7);\n\
         ENDSEC;\n\
         END-ISO-10303-21;\n",
        proj = gid("0PROJECT"),
        wall = gid("0WALL"),
        qto = gid("0QTO"),
        rel = gid("0REL"),
    )
}

/// The gap this return value closes: two files that differ ONLY in their
/// declared length unit produce byte-identical rows. A consumer writing
/// those quantities next to geometry — which the geometry exporters DO
/// normalise to metres — has a 1000x mismatch and, before this, nothing in
/// the export API with which to notice.
#[test]
fn rows_alone_cannot_distinguish_a_millimetre_model_from_a_metre_one() {
    let mm = wall_with_length(".MILLI.");
    let m = wall_with_length("$");

    let mm_model = build_export_model(mm.as_bytes());
    let m_model = build_export_model(m.as_bytes());

    // Same rows. This is the point: the 3000 is 3 m in one file and 3000 m
    // in the other, and `EntityRow` says 3000 either way.
    assert_eq!(
        mm_model.entities, m_model.entities,
        "the rows must be identical — if they ever diverge, this test is \
         no longer demonstrating what it claims"
    );
    let wall = mm_model
        .entities
        .iter()
        .find(|r| r.ifc_type == "IfcWall")
        .expect("the wall must get a row");
    let length = wall
        .quantity_sets
        .iter()
        .flat_map(|qs| &qs.quantities)
        .find(|q| q.name == "Length")
        .expect("the quantity must survive to the row");
    assert_eq!(length.value, 3000.0, "carried in the file's own units");

    // And the units, which are the only thing that tells them apart.
    assert_eq!(mm_model.units.length_unit_scale, 0.001);
    assert_eq!(m_model.units.length_unit_scale, 1.0);
    assert_eq!(mm_model.units.project_id, Some(4));
}

/// `stream_export_model_with_index` must resolve the same scales as the
/// convenience wrappers: it is the entry point a memory-bounded caller uses,
/// and it is the one that builds the decoder the resolver runs against.
#[test]
fn every_entry_point_reports_the_same_scales() {
    let mm = wall_with_length(".MILLI.");
    let bytes = mm.as_bytes();

    let streamed = stream_export_model(bytes, |_| {});
    let index = Arc::new(ifc_lite_processing::build_entity_index_parallel(bytes));
    let with_index = stream_export_model_with_index(bytes, &index, |_| {});

    assert_eq!(build_export_model(bytes).units, streamed);
    assert_eq!(streamed, with_index);
    assert_eq!(streamed.length_unit_scale, 0.001);
}

/// A wall placed at (3000, 2000, 1000) in the file's own units, under an
/// `IfcLocalPlacement` chain of two levels — a site and the wall — so the test
/// exercises composition rather than a single leaf.
fn placed_wall(prefix: &str) -> String {
    format!(
        "ISO-10303-21;\n\
         HEADER;\n\
         FILE_DESCRIPTION((''),'');\n\
         FILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\n\
         ENDSEC;\n\
         DATA;\n\
         #1=IFCSIUNIT(*,.LENGTHUNIT.,{prefix},.METRE.);\n\
         #2=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);\n\
         #3=IFCUNITASSIGNMENT((#1,#2));\n\
         #4=IFCPROJECT('{proj}',$,'P',$,$,$,$,$,#3);\n\
         #10=IFCCARTESIANPOINT((0.,0.,0.));\n\
         #11=IFCAXIS2PLACEMENT3D(#10,$,$);\n\
         #12=IFCLOCALPLACEMENT($,#11);\n\
         #13=IFCCARTESIANPOINT((3000.,2000.,1000.));\n\
         #14=IFCAXIS2PLACEMENT3D(#13,$,$);\n\
         #15=IFCLOCALPLACEMENT(#12,#14);\n\
         #20=IFCWALL('{wall}',$,'W',$,$,#15,$,$,$);\n\
         #21=IFCWALL('{free}',$,'U',$,$,$,$,$,$);\n\
         ENDSEC;\n\
         END-ISO-10303-21;\n",
        proj = gid("0PROJECT"),
        wall = gid("0WALL"),
        free = gid("0FREE"),
    )
}

fn row_named<'a>(rows: &'a [EntityRow], name: &str) -> &'a EntityRow {
    rows.iter()
        .find(|r| r.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("no row named {name}"))
}

fn rows_with(content: &str, opts: &ModelOptions) -> Vec<EntityRow> {
    let bytes = content.as_bytes();
    let index = Arc::new(ifc_lite_processing::build_entity_index_parallel(bytes));
    let mut rows = Vec::new();
    stream_export_model_with_options(bytes, &index, opts, |r, _| rows.push(r));
    rows
}

/// Off by default, and the default path must not have changed shape.
#[test]
fn placements_are_not_resolved_unless_asked_for() {
    let rows = rows_with(&placed_wall(".MILLI."), &ModelOptions::default());
    assert!(rows.iter().all(|r| r.placement.is_none()));

    // And the old entry point still produces exactly the same rows.
    let bytes = placed_wall(".MILLI.");
    let mut old = Vec::new();
    stream_export_model(bytes.as_bytes(), |r| old.push(r));
    assert_eq!(old, rows, "the wrapper must not change what it emits");
}

/// The translation is in METRES. This is the failure the doc comment on
/// `Placement` exists to prevent, and the one a `GeometryRouter::new()` instead
/// of `with_scale` would produce: 3000 rather than 3.
#[test]
fn a_resolved_placement_is_in_metres_not_the_files_own_units() {
    let opts = ModelOptions::default().with_placements(true);
    let mm = rows_with(&placed_wall(".MILLI."), &opts);
    let m = rows_with(&placed_wall("$"), &opts);

    let mm_t = row_named(&mm, "W").placement.expect("placed").translation();
    let m_t = row_named(&m, "W").placement.expect("placed").translation();

    assert_eq!(mm_t, [3.0, 2.0, 1.0], "millimetre file, metres out");
    assert_eq!(m_t, [3000.0, 2000.0, 1000.0], "metre file, metres out");
}

/// Column-major, which is the other half of the frame claim: translation lives
/// at 12/13/14, not at 3/7/11. A row-major reader would find zeros there and
/// silently place everything at the origin.
#[test]
fn the_matrix_is_column_major() {
    let opts = ModelOptions::default().with_placements(true);
    let rows = rows_with(&placed_wall("$"), &opts);
    let m = row_named(&rows, "W").placement.expect("placed").matrix;

    assert_eq!([m[12], m[13], m[14]], [3000.0, 2000.0, 1000.0]);
    assert_eq!(
        [m[3], m[7], m[11]],
        [0.0, 0.0, 0.0],
        "the row-major translation slots are the homogeneous row here"
    );
    assert_eq!(m[15], 1.0);
}

/// `None` must mean "this product has no ObjectPlacement", and must NOT be
/// confused with the identity the resolver returns for an absent one — which is
/// why the code checks attribute 5 rather than the resolver's Result.
#[test]
fn a_product_with_no_object_placement_is_none_not_the_origin() {
    let opts = ModelOptions::default().with_placements(true);
    let rows = rows_with(&placed_wall("$"), &opts);
    assert!(
        row_named(&rows, "U").placement.is_none(),
        "an unplaced product must not be reported as sitting at the origin"
    );
    assert!(row_named(&rows, "W").placement.is_some());
}

/// The chain composes, and composes in the right ORDER.
///
/// Two translations commute, so an offset parent alone proves only that
/// composition happens. The parent here is rotated 90 degrees about Z as well
/// as offset: `parent * local` puts the wall at (10-2000, 20+3000, 30+1000) =
/// (-1990, 3020, 1030), while `local * parent` would put it somewhere else
/// entirely. Only one of those is the IFC rule.
#[test]
fn the_placement_chain_composes_parent_then_local() {
    let content = placed_wall("$")
        .replace(
            "#10=IFCCARTESIANPOINT((0.,0.,0.));",
            "#10=IFCCARTESIANPOINT((10.,20.,30.));\n             #16=IFCDIRECTION((0.,0.,1.));\n             #17=IFCDIRECTION((0.,1.,0.));",
        )
        .replace(
            "#11=IFCAXIS2PLACEMENT3D(#10,$,$);",
            "#11=IFCAXIS2PLACEMENT3D(#10,#16,#17);",
        );

    let opts = ModelOptions::default().with_placements(true);
    let rows = rows_with(&content, &opts);
    let t = row_named(&rows, "W").placement.expect("placed").translation();

    let close = |a: f64, b: f64| (a - b).abs() < 1e-9;
    assert!(
        close(t[0], -1990.0) && close(t[1], 3020.0) && close(t[2], 1030.0),
        "parent (rotated 90 deg about Z, offset 10/20/30) applied to the wall's \
         own (3000, 2000, 1000) must give (-1990, 3020, 1030), got {t:?}"
    );
}

/// The rows a caller gets must not depend on which entry point produced them,
/// including with placements on — `stream == build` is what the equality tests
/// on this module rest on.
#[test]
fn build_and_stream_agree_with_options_too() {
    let opts = ModelOptions::default().with_placements(true);
    let content = placed_wall(".MILLI.");
    let built = build_export_model_with_options(content.as_bytes(), &opts);
    assert_eq!(built.entities, rows_with(&content, &opts));
    assert_eq!(built.units.length_unit_scale, 0.001);
}

/// The decoded entity reaches the callback, and it is the one the row was built
/// from. This is the whole point of the second argument: an attribute this
/// crate does not surface is reachable by name.
#[test]
fn the_callback_receives_the_entity_each_row_was_built_from() {
    let content = placed_wall("$");
    let bytes = content.as_bytes();
    let index = Arc::new(ifc_lite_processing::build_entity_index_parallel(bytes));

    let mut seen = Vec::new();
    stream_export_model_with_options(bytes, &index, &ModelOptions::default(), |row, entity| {
        let entity = entity.expect("an IfcProduct row has an occurrence entity");
        assert_eq!(entity.id, row.express_id, "the row's own entity, not another");
        // Attribute 2 is Name for every rooted entity. A consumer should reach
        // it through `IfcType::attribute_index("Name")` rather than a literal;
        // this asserts the entity arrives, which is what the argument is for.
        seen.push(entity.get(2).and_then(|a| a.as_string()).map(str::to_string));
    });
    assert_eq!(seen, vec![Some("W".to_string()), Some("U".to_string())]);
}
