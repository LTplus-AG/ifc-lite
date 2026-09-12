// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use ifc_lite_core::{AttributeValue as A, EntityDecoder, EntityScanner};

pub(super) const CONTROLLED_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-1781 image texture fixture'),'2;1');
FILE_NAME('imgtex.ifc','2026-07-17T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6d',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCBUILDINGELEMENTPROXY('1ProxyImageTexture000',$,'Textured',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#14));
#14=IFCTRIANGULATEDFACESET(#15,$,.T.,((1,2,3),(1,2,4),(1,4,3),(2,3,4)),$);
#15=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,1.)));
#20=IFCIMAGETEXTURE(.T.,.F.,$,$,$,'textures/wood.jpg');
#21=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.),(1.,1.)));
#22=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#14,#21,$);
#23=IFCSTYLEDITEM(#14,(#24),$);
#24=IFCSURFACESTYLE('Wood',.BOTH.,(#25,#26));
#25=IFCSURFACESTYLERENDERING(#27,0.,$,$,$,$,$,$,.NOTDEFINED.);
#26=IFCSURFACESTYLEWITHTEXTURES((#20));
#27=IFCCOLOURRGB($,0.5,0.4,0.3);
#30=IFCBUILDINGELEMENTPROXY('1ProxyImageTexture001',$,'Textured2',$,$,#31,#32,$,$);
#31=IFCLOCALPLACEMENT($,#5);
#32=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
#33=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#34));
#34=IFCTRIANGULATEDFACESET(#35,$,.F.,((1,2,3)),$);
#35=IFCCARTESIANPOINTLIST3D(((0.,0.,5.),(1.,0.,5.),(0.,1.,5.)));
#36=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));
#37=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#34,#36,((3,2,1)));
ENDSEC;
END-ISO-10303-21;
"#;

fn request(products: Vec<u32>) -> AppearanceRequest {
    AppearanceRequest {
        representation_policy: RepresentationPolicy::Preserve,
        schema: "IFC4".into(),
        source_revision: "revision-1".into(),
        next_express_id: 100,
        product_ids: products,
        image_uri: "appearance/new.png".into(),
        repeat_s: true,
        repeat_t: false,
        mapping: Mapping::ExistingUv {
            scale: [2., 3.],
            offset: [0.25, 0.5],
            rotation_radians: 0.,
        },
    }
}
fn wire(value: &A) -> Value {
    match value {
        A::EntityRef(id) => reference(*id),
        A::String(s) => json!(s),
        A::Enum(s) => json!(format!(".{s}.")),
        A::Integer(n) => json!(n),
        A::Float(n) => json!(n),
        A::List(values) if values.len() == 2 && values[0].as_string().is_some_and(|s| s.starts_with("IFC")) =>
            json!({"typed": {"type": values[0].as_string().unwrap(), "value": wire(&values[1])}}),
        A::List(values) => Value::Array(values.iter().map(wire).collect()),
        A::Null => Value::Null,
        A::Derived => json!("*"),
    }
}
fn step(value: &Value) -> String {
    match value {
        Value::Object(value) if value.contains_key("typed") => {
            let typed = &value["typed"];
            // Mirrors the host writer, which upper-cases the STEP type keyword.
            format!("{}({})", typed["type"].as_str().unwrap().to_uppercase(), step(&typed["value"]))
        },
        Value::Null => "$".into(),
        Value::Array(values) => format!(
            "({})",
            values.iter().map(step).collect::<Vec<_>>().join(",")
        ),
        Value::String(s) if {
            let token=s.trim();
            matches!(token,"$"|"*")
                || token.strip_prefix('#').is_some_and(|id|!id.is_empty() && id.bytes().all(|c|c.is_ascii_digit()))
                || token.strip_prefix('.').and_then(|s|s.strip_suffix('.')).is_some_and(|s|!s.is_empty() && s.bytes().all(|c|c.is_ascii_alphanumeric() || c==b'_'))
        } => s.trim().into(),
        Value::String(s) => format!("'{}'", s.replace('\'', "''")),
        other => other.to_string(),
    }
}
/// Test-only consumer: apply typed mutations to decoded source records, then
/// re-open the resulting actual IFC through the production geometry pipeline.
pub(super) fn apply(source: &str, plan: &AppearancePlan) -> String {
    let mut output = source[..source.find("DATA;").unwrap() + 5].to_string();
    let mut scan = EntityScanner::new(source.as_bytes());
    let mut decoder = EntityDecoder::new(source);
    while let Some((id, name, start, end)) = scan.next_entity() {
        if plan.removed.contains(&id) {
            continue;
        }
        let entity = decoder.decode_at_with_id(id, start, end).unwrap();
        let mut attributes: Vec<Value> = entity.attributes.iter().map(wire).collect();
        for edit in plan.edits.iter().filter(|edit| edit.express_id == id) {
            attributes[edit.index] = edit.value.clone();
        }
        output.push_str(&format!(
            "\n#{id}={name}({});",
            attributes.iter().map(step).collect::<Vec<_>>().join(",")
        ));
    }
    for entity in &plan.created {
        output.push_str(&format!(
            "\n#{}={}({});",
            entity.express_id,
            entity.r#type.to_uppercase(),
            entity
                .attributes
                .iter()
                .map(step)
                .collect::<Vec<_>>()
                .join(",")
        ));
    }
    output.push_str("\nENDSEC;\nEND-ISO-10303-21;\n");
    output
}
#[test]
fn issue_4243_existing_uv_plan_roundtrips_without_geometry_or_other_owner_changes() {
    let plan = plan_appearance(CONTROLLED_IFC.as_bytes(), &request(vec![10])).unwrap();
    assert!(plan.exclusions.is_empty());
    assert_eq!(plan.items.len(), 1);
    assert_eq!(plan.next_express_id, 100);
    assert_eq!(plan.next_available_express_id, 107);
    assert_eq!(plan.removed, vec![22]);
    assert_eq!(plan.edits[0].express_id, 23);
    assert_eq!(plan.items[0].tex_coords[0], [0.25, 0.5]);
    let before = crate::process_geometry(CONTROLLED_IFC.as_bytes());
    let output = apply(CONTROLLED_IFC, &plan);
    let after = crate::process_geometry(output.as_bytes());
    for old in &before.meshes {
        let new = after
            .meshes
            .iter()
            .find(|m| m.express_id == old.express_id)
            .unwrap();
        assert_eq!(old.positions, new.positions);
        assert_eq!(old.indices, new.indices);
        assert_eq!(old.normals, new.normals);
        if old.express_id == 10 {
            assert_eq!(corner_uvs(new), plan.items[0].preview_corner_uvs);
            assert_eq!(
                new.texture.as_ref().unwrap().url.as_deref(),
                Some("appearance/new.png")
            );
        } else {
            assert_eq!(old.uvs, new.uvs);
            assert_eq!(
                old.texture.as_ref().unwrap().texture_id,
                new.texture.as_ref().unwrap().texture_id
            );
        }
    }
    let mut decoder = EntityDecoder::new(&output);
    assert_eq!(
        decoder.decode_by_id(24).unwrap().get_ref(0),
        None,
        "shared old style definition remains untouched"
    );
    assert!(
        decoder.decode_by_id(20).is_ok(),
        "unselected object still owns original image"
    );
}
#[test]
fn issue_4243_shared_geometry_and_invalid_scope_produce_explicit_exclusions() {
    let shared = CONTROLLED_IFC.replace("#31,#32,$,$)", "#31,#12,$,$)");
    let plan = plan_appearance(shared.as_bytes(), &request(vec![10, 30])).unwrap();
    assert_eq!(plan.exclusions.len(), 2);
    assert!(plan.created.is_empty());
    let missing = plan_appearance(CONTROLLED_IFC.as_bytes(), &request(vec![999])).unwrap();
    assert_eq!(missing.exclusions.len(), 1);
    let mut req = request(vec![10]);
    req.next_express_id = 37;
    assert!(plan_appearance(CONTROLLED_IFC.as_bytes(), &req)
        .unwrap_err()
        .contains("watermark"));
    req.next_express_id = 100;
    req.image_uri = "../private.png".into();
    assert!(plan_appearance(CONTROLLED_IFC.as_bytes(), &req).is_err());
}
#[test]
fn issue_4243_planar_world_mapping_uses_canonical_metre_conversion_and_placement() {
    let mut req = request(vec![30]);
    req.mapping = Mapping::Planar {
        frame: MappingFrame::World,
        origin: [0., 0., 0.],
        axis_u: [1., 0., 0.],
        axis_v: [0., 1., 0.],
        metres_per_tile: [2., 2.],
    };
    let metres = CONTROLLED_IFC.replace(
        "#4=IFCCARTESIANPOINT((0.,0.,0.))",
        "#4=IFCCARTESIANPOINT((10.,20.,0.))",
    );
    let millimetres = metres
        .replace(".LENGTHUNIT.,$,.METRE.", ".LENGTHUNIT.,.MILLI.,.METRE.")
        .replace("(10.,20.,0.)", "(10000.,20000.,0.)")
        .replace(
            "((0.,0.,5.),(1.,0.,5.),(0.,1.,5.))",
            "((0.,0.,5000.),(1000.,0.,5000.),(0.,1000.,5000.))",
        );
    let m = plan_appearance(metres.as_bytes(), &req).unwrap();
    let mm = plan_appearance(millimetres.as_bytes(), &req).unwrap();
    assert!(m.exclusions.is_empty(), "{:?}", m.exclusions);
    assert!(mm.exclusions.is_empty(), "{:?}", mm.exclusions);
    assert_eq!(m.items[0].tex_coords, mm.items[0].tex_coords);
    assert_eq!(m.items[0].tex_coords[0], [5., 10.]);
    assert_eq!(m.items[0].tex_coords[1], [5.5, 10.]);
}
#[test]
fn issue_4243_untextured_planar_and_box_maps_have_valid_corner_correspondence() {
    let source = CONTROLLED_IFC.replace(
        "#37=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#34,#36,((3,2,1)));",
        "",
    );
    let existing = plan_appearance(source.as_bytes(), &request(vec![30])).unwrap();
    assert_eq!(existing.exclusions.len(), 1);
    let mut req = request(vec![30]);
    req.mapping = Mapping::Box {
        frame: MappingFrame::Item,
        origin: [0., 0., 0.],
        metres_per_tile: [1., 1., 1.],
    };
    let plan = plan_appearance(source.as_bytes(), &req).unwrap();
    assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
    assert_eq!(plan.items[0].tex_coord_index, vec![[1, 2, 3]]);
    let reopened = crate::process_geometry(apply(&source, &plan).as_bytes());
    let mesh = reopened.meshes.iter().find(|m| m.express_id == 30).unwrap();
    assert_eq!(corner_uvs(mesh), plan.items[0].preview_corner_uvs);
}
#[test]
fn issue_4243_corrupt_mapping_excludes_entire_product_and_does_not_mutate() {
    let corrupt = CONTROLLED_IFC.replace(
        "#22=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#14,#21,$)",
        "#22=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#14,#21,((999,2,3)))",
    );
    let plan = plan_appearance(corrupt.as_bytes(), &request(vec![10])).unwrap();
    assert_eq!(plan.exclusions.len(), 1);
    assert!(plan.created.is_empty());
    assert!(plan.removed.is_empty());
}

#[test]
fn issue_4243_world_projection_reports_cyclic_placement_instead_of_partial_transform() {
    let cyclic = CONTROLLED_IFC.replace(
        "#31=IFCLOCALPLACEMENT($,#5)",
        "#31=IFCLOCALPLACEMENT(#31,#5)",
    );
    let mut req = request(vec![30]);
    req.mapping = Mapping::Planar {
        frame: MappingFrame::World,
        origin: [0., 0., 0.],
        axis_u: [1., 0., 0.],
        axis_v: [0., 1., 0.],
        metres_per_tile: [1., 1.],
    };
    let plan = plan_appearance(cyclic.as_bytes(), &req).unwrap();
    assert!(plan.created.is_empty());
    assert!(plan.exclusions[0].reason.contains("cycle/depth"));
}
#[test]
fn issue_4243_wire_contract_has_camelcase_variants_and_stable_allocation_start() {
    let req: AppearanceRequest = serde_json::from_value(json!({
        "schema":"IFC4","sourceRevision":"test","nextExpressId":100,"productIds":[30],
        "imageUri":"appearance/image.png","repeatS":true,"repeatT":false,
        "mapping":{"kind":"existingUv","scale":[1,1],"offset":[0,0],"rotationRadians":0}
    }))
    .unwrap();
    let plan = plan_appearance(CONTROLLED_IFC.as_bytes(), &req).unwrap();
    let value = serde_json::to_value(&plan).unwrap();
    assert_eq!(value["nextExpressId"], 100);
    assert_eq!(value["created"][0]["expressId"], 100);
    assert_eq!(value["created"][0]["type"], "IfcImageTexture");
    assert_eq!(value["items"][0]["geometryItemId"], 34);
}
#[test]
fn issue_4243_optional_convento_walls() {
    let Ok(path) = std::env::var("IFCLITE_APPEARANCE_CORPUS_IFC") else {
        eprintln!("Skipping Convento appearance corpus: run pnpm fixtures, unwrap textures/ifc-hbim-convento-textures.ifczip and set IFCLITE_APPEARANCE_CORPUS_IFC");
        return;
    };
    let bytes = std::fs::read(path).expect("read explicitly supplied corpus IFC");
    let mut scanner = EntityScanner::new(&bytes);
    let mut ids = Vec::new();
    let mut max_id = 0;
    while let Some((id, name, _, _)) = scanner.next_entity() {
        max_id = max_id.max(id);
        if name == "IFCWALL" {
            ids.push(id);
        }
    }
    assert!(!ids.is_empty());
    let mut req = request(ids);
    req.next_express_id = max_id + 1;
    let start = std::time::Instant::now();
    let plan = plan_appearance(&bytes, &req).unwrap();
    eprintln!(
        "Convento: {} products, {} items, {} exclusions, {:?}",
        req.product_ids.len(),
        plan.items.len(),
        plan.exclusions.len(),
        start.elapsed()
    );
    assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
    assert!(!plan.items.is_empty());
    req.mapping = Mapping::Planar { frame: MappingFrame::World, origin: [0.;3], axis_u: [1.,0.,0.], axis_v: [0.,1.,0.], metres_per_tile: [1.,1.] };
    let planar = plan_appearance(&bytes, &req).unwrap();
    assert!(planar.exclusions.is_empty(), "{:?}", planar.exclusions);
    assert_eq!(planar.items.len(), plan.items.len());
    for item in &planar.items {
        assert_eq!(item.target_corner_normals.len(), item.target_indices.len() * 3);
        assert!(item.target_corner_normals.iter().all(|v| v.is_finite()));
    }
    eprintln!("Convento planar: {} products, {} items, {} exclusions", req.product_ids.len(), planar.items.len(), planar.exclusions.len());
    // Actual full-model UI failure: item187 retains vertex27 after cleanup,
    // while only27 triangle corners remain. The canonical pool is authoritative.
    req.product_ids = vec![151];
    let sparse = plan_appearance(&bytes, &req).unwrap();
    assert!(sparse.exclusions.is_empty(), "{:?}", sparse.exclusions);
    let item = sparse.items.iter().find(|item| item.geometry_item_id == 187).unwrap();
    assert!(item.target_indices.iter().any(|&i| i as usize >= item.target_indices.len()));
    assert!(item.target_indices.iter().all(|&i| (i as usize) < item.target_vertex_count));
    eprintln!("Convento item187: {} surviving corners, {} canonical vertices", item.target_indices.len(), item.target_vertex_count);

}

fn corner_uvs(mesh: &crate::types::mesh::MeshData) -> Vec<f32> {
    let uvs = mesh.uvs.as_ref().unwrap();
    mesh.indices
        .iter()
        .flat_map(|&i| [uvs[i as usize * 2], uvs[i as usize * 2 + 1]])
        .collect()
}

#[test]
fn issue_4243_final_welded_topology_matches_reopen_and_repeated_appearance() {
    let source = CONTROLLED_IFC
        .replace(
            "#34=IFCTRIANGULATEDFACESET(#35,$,.F.,((1,2,3)),$);",
            "#34=IFCTRIANGULATEDFACESET(#35,$,.F.,((1,2,3),(1,3,4)),$);",
        )
        .replace(
            "#35=IFCCARTESIANPOINTLIST3D(((0.,0.,5.),(1.,0.,5.),(0.,1.,5.)));",
            "#35=IFCCARTESIANPOINTLIST3D(((0.,0.,5.),(1.,0.,5.),(1.,1.,5.),(0.,1.,5.)));",
        )
        .replace(
            "#36=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));",
            "#36=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(1.,1.),(0.,1.),(0.5,0.)));",
        )
        .replace(
            "#37=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#34,#36,((3,2,1)));",
            "#37=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#34,#36,((1,2,3),(5,3,4)));",
        );
    let mut req = request(vec![30]);
    req.mapping = Mapping::Planar {
        frame: MappingFrame::Item,
        origin: [0., 0., 0.],
        axis_u: [1., 0., 0.],
        axis_v: [0., 1., 0.],
        metres_per_tile: [1., 1.],
    };
    for input in [
        &source,
        &source.replace(
            "#37=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#34,#36,((1,2,3),(5,3,4)));",
            "",
        ),
    ] {
        let plan = plan_appearance(input.as_bytes(), &req).unwrap();
        assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
        let before = crate::process_geometry(input.as_bytes());
        let old = before
            .meshes
            .iter()
            .find(|mesh| mesh.express_id == 30)
            .unwrap();
        let output = apply(input, &plan);
        let after = crate::process_geometry(output.as_bytes());
        let new = after
            .meshes
            .iter()
            .find(|mesh| mesh.express_id == 30)
            .unwrap();
        let item = &plan.items[0];
        assert_eq!(item.source_indices, old.indices);
        assert_eq!(item.target_indices, new.indices);
        assert_eq!(item.preview_corner_uvs, corner_uvs(new));
        assert_eq!(
            new.positions.len(),
            12,
            "final canonical planar quad is welded to four vertices"
        );
        assert_eq!(
            item.preview_corner_uvs.len(),
            12,
            "preview carries six independent UV corners"
        );
        for (&a, &b) in old.indices.iter().zip(&new.indices) {
            assert_eq!(
                &old.positions[a as usize * 3..a as usize * 3 + 3],
                &new.positions[b as usize * 3..b as usize * 3 + 3]
            );
        }
        let mut repeated = request(vec![30]);
        repeated.next_express_id = plan.next_available_express_id;
        let next = plan_appearance(output.as_bytes(), &repeated).unwrap();
        assert!(next.exclusions.is_empty(), "{:?}", next.exclusions);
        assert_eq!(
            next.items[0].source_indices, item.target_indices,
            "committed target provenance must validate the next appearance draft"
        );
    }
}

#[test]
fn issue_4243_shared_coordinates_cannot_amplify_an_unbounded_plan() {
    let points = (0..10_000).map(|i| format!("({}, {}, 0.)", i % 100, i / 100)).collect::<Vec<_>>().join(",");
    let mut entities = format!("#90=IFCCARTESIANPOINTLIST3D(({points}));\n");
    let mut products = Vec::new();
    for i in 0..51 {
        let id = 100 + i * 4;
        products.push(id);
        entities.push_str(&format!("#{}=IFCBUILDINGELEMENTPROXY('0Proxy000000000000000a',$,'Surface',$,$,$,#{},$,$);\n#{}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{}));\n#{}=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#{}));\n#{}=IFCTRIANGULATEDFACESET(#90,$,.F.,((1,2,101)),$);\n", id, id+1, id+1, id+2, id+2, id+3, id+3));
    }
    let source = CONTROLLED_IFC.replace("ENDSEC;\nEND-ISO-10303-21;", &format!("{entities}ENDSEC;\nEND-ISO-10303-21;"));
    let mut req = request(products[..4].to_vec());
    req.next_express_id = 10_000;
    req.mapping = Mapping::Planar { frame: MappingFrame::Item, origin: [0.;3], axis_u: [1.,0.,0.], axis_v: [0.,1.,0.], metres_per_tile: [1.,1.] };
    let accepted = plan_appearance(source.as_bytes(), &req).unwrap();
    assert_eq!(accepted.items.len(), 4);
    assert_eq!(accepted.items.iter().map(|item| item.tex_coords.len()).sum::<usize>(), 40_000);
    req.product_ids = products;
    // A resource refusal must not return the 50 already prepared products.
    assert!(matches!(plan_appearance(source.as_bytes(), &req), Err(reason) if reason.contains("geometry/output budget")));
}

#[test]
fn issue_4243_bounds_canonical_texture_index_before_unselected_map_expansion() {
    let uv = std::iter::repeat_n("(0.,0.)", 10_000).collect::<Vec<_>>().join(",");
    let mut extra = format!("#90=IFCTEXTUREVERTEXLIST(({uv}));\n");
    for i in 0..51 {
        // These maps are outside the requested product but canonical indexing
        // still resolves each shared list before normal product eligibility.
        extra.push_str(&format!("#{}=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#{},#90,((1,2,3)));\n", 100+i, 1000+i));
    }
    let source = CONTROLLED_IFC.replace("ENDSEC;\nEND-ISO-10303-21;", &format!("{extra}ENDSEC;\nEND-ISO-10303-21;"));
    let mut req = request(vec![10]);
    req.next_express_id = 10_000;
    assert!(matches!(plan_appearance(source.as_bytes(), &req), Err(reason) if reason.contains("source texture budget")));
}

#[test]
fn issue_4243_embedded_pixel_dimensions_are_budgeted_before_resolver_allocation() {
    for dimension in [16_384u64, u32::MAX as u64] {
        let source = CONTROLLED_IFC.replace("IFCIMAGETEXTURE(.T.,.F.,$,$,$,'textures/wood.jpg')", &format!("IFCPIXELTEXTURE(.T.,.F.,$,$,$,{dimension},{dimension},4,())"));
        assert!(matches!(plan_appearance(source.as_bytes(), &request(vec![10])), Err(reason) if reason.contains("source texture budget")));
    }
}

#[test]
fn issue_4243_embedded_blob_header_is_budgeted_before_pixel_decode() {
    // A valid 16384-square PNG header, no large pixel buffer or compressed stream.
    let binary = "089504e470d0a1a0a0000000d49484452000040000000400008000000008ca34f58000000004944415435af061e";
    let source = CONTROLLED_IFC.replace("IFCIMAGETEXTURE(.T.,.F.,$,$,$,'textures/wood.jpg')", &format!("IFCBLOBTEXTURE(.T.,.F.,$,$,$,'PNG',\"{binary}\")"));
    assert!(matches!(plan_appearance(source.as_bytes(), &request(vec![10])), Err(reason) if reason.contains("source texture budget")));
}

#[test]
fn issue_4243_per_item_coordinate_limit_exhausts_the_whole_plan_budget() {
    use super::budget::{PlanBudget, BUDGET_ERROR, MAX_COORDINATE_ROWS};
    // Existing UVs can reference just three points in a much larger point list.
    // Such an item must exhaust the request before row decoding can downgrade
    // its resource failure to an exclusion and retain earlier prepared items.
    let mut budget = PlanBudget::default();
    budget.reserve(3, 1, 3).unwrap();
    assert_eq!(
        budget.reserve(MAX_COORDINATE_ROWS + 1, 1, 3),
        Err(BUDGET_ERROR.into())
    );
    assert!(budget.exhausted);

    let mut boundary = PlanBudget::default();
    assert!(boundary.reserve(MAX_COORDINATE_ROWS, 1, 3).is_ok());
    assert!(!boundary.exhausted);
}

#[test]
fn issue_4272_georeferenced_topology_matches_canonical_reopen() {
    let source = CONTROLLED_IFC.replace("#4=IFCCARTESIANPOINT((0.,0.,0.));", "#4=IFCCARTESIANPOINT((5000000.,6000000.,0.));")
        .replace("(1.,0.,0.)", "(0.01,0.,0.)")
        .replace("(0.,1.,0.)", "(0.,0.01,0.)")
        .replace("(0.,0.,1.)", "(0.,0.,0.01)");
    let plan = plan_appearance(source.as_bytes(), &request(vec![10, 30])).unwrap();
    assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
    assert_eq!(plan.items.len(), 2);
    let before = crate::process_geometry(source.as_bytes());
    let output = apply(&source, &plan);
    let after = crate::process_geometry(output.as_bytes());
    for item in &plan.items {
        let old = before.meshes.iter().find(|m| m.express_id == item.product_id).unwrap();
        let new = after.meshes.iter().find(|m| m.express_id == item.product_id).unwrap();
        assert_eq!(item.source_indices, old.indices);
        assert_eq!(item.target_indices, new.indices);
        assert_eq!(item.preview_corner_uvs, corner_uvs(new));
        assert_eq!(old.indices.len(), if item.product_id == 10 { 12 } else { 3 });
    }
}

#[test]
fn issue_4272_layer_slicing_is_explicitly_excluded_before_authoring() {
    let layers = "#40=IFCMATERIAL('Finish',$,$);\n#41=IFCMATERIALLAYER(#40,0.05,$,$,$,$,$);\n#42=IFCMATERIALLAYER(#40,0.2,$,$,$,$,$);\n#43=IFCMATERIALLAYERSET((#41,#42),$,$);\n#44=IFCMATERIALLAYERSETUSAGE(#43,.AXIS2.,.POSITIVE.,0.,$);\n#45=IFCRELASSOCIATESMATERIAL('0Proxy000000000000000a',$,$,$,(#10),#44);\n";
    let source = CONTROLLED_IFC.replace("IFCBUILDINGELEMENTPROXY('1ProxyImageTexture000'", "IFCWALL('1ProxyImageTexture000'").replace("ENDSEC;\nEND-ISO-10303-21;", &format!("{layers}ENDSEC;\nEND-ISO-10303-21;"));
    let mut decoder = EntityDecoder::new(source.as_bytes());
    assert!(ifc_lite_geometry::MaterialLayerIndex::from_content(source.as_bytes(), &mut decoder).is_sliceable(10));
    let plan = plan_appearance(source.as_bytes(), &request(vec![10])).unwrap();
    assert!(plan.items.is_empty());
    assert!(plan.created.is_empty());
    assert!(plan.edits.is_empty());
    assert!(plan.removed.is_empty());
    assert_eq!(plan.exclusions.len(), 1);
    assert!(plan.exclusions[0].reason.contains("Material-layer slicing"));
}

#[test]
fn issue_4243_planar_uv_seam_merge_preserves_positions_and_canonical_target_shading() {
    // Two nearly coplanar triangles share positions but start on different atlas
    // seams. Planar mapping merges their quantized-normal weld representatives.
    let source = CONTROLLED_IFC
        .replace("#34=IFCTRIANGULATEDFACESET(#35,$,.F.,((1,2,3)),$);", "#34=IFCTRIANGULATEDFACESET(#35,$,.F.,((1,2,3),(4,5,6)),$);")
        .replace("#35=IFCCARTESIANPOINTLIST3D(((0.,0.,5.),(1.,0.,5.),(0.,1.,5.)));", "#35=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(0.,1.,0.),(0.,0.,0.),(0.,1.,0.),(-1.,0.,0.0002)));")
        .replace("#36=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));", "#36=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.),(0.5,0.5),(0.5,1.),(1.,1.)));")
        .replace("#37=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#34,#36,((3,2,1)));", "#37=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#34,#36,((1,2,3),(4,5,6)));");
    let mut req = request(vec![30]);
    req.mapping = Mapping::Planar { frame: MappingFrame::Item, origin: [0.;3], axis_u: [1.,0.,0.], axis_v: [0.,1.,0.], metres_per_tile: [1.,1.] };
    let plan = plan_appearance(source.as_bytes(), &req).unwrap();
    assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
    let before = crate::process_geometry(source.as_bytes());
    let output = apply(&source, &plan);
    let after = crate::process_geometry(output.as_bytes());
    let old = before.meshes.iter().find(|m| m.express_id == 30).unwrap();
    let new = after.meshes.iter().find(|m| m.express_id == 30).unwrap();
    let corners = |values: &[f32], indices: &[u32]| -> Vec<f32> {
        indices.iter().flat_map(|&i| values[i as usize*3..i as usize*3+3].iter().copied()).collect()
    };
    assert_eq!(corners(&old.positions, &old.indices), corners(&new.positions, &new.indices));
    assert_ne!(corners(&old.normals, &old.indices), corners(&new.normals, &new.indices));
    assert_eq!(plan.items[0].source_indices, old.indices);
    assert_eq!(plan.items[0].target_indices, new.indices);
    let target_normals: Vec<f32> = new.indices.iter().flat_map(|&i| {
        let i = i as usize * 3;
        [new.normals[i], new.normals[i+2], -new.normals[i+1]]
    }).collect();
    assert_eq!(plan.items[0].target_corner_normals, target_normals);
}

#[test]
fn issue_4272_invalid_pixel_dimensions_fail_preflight_without_partial_plan() {
    for dimensions in ["-1,1", "1,0", "4294967296,1", "1,16385", "$ ,1", "'bad',1"] {
        let source = CONTROLLED_IFC.replace("#20=IFCIMAGETEXTURE(.T.,.F.,$,$,$,'textures/wood.jpg');", &format!("#20=IFCPIXELTEXTURE(.T.,.F.,$,$,$,{dimensions},3,(\"0FF0000\"));"));
        assert!(matches!(plan_appearance(source.as_bytes(), &request(vec![10,30])), Err(reason) if reason.contains("Invalid embedded pixel texture dimensions")), "{dimensions}");
    }
}

#[test]
fn issue_4272_canonical_corner_validation_rejects_missing_or_overflowing_slices() {
    let positions = [0., 0., 0., 1., 2., 3.];
    assert_eq!(canonical::corner_position(&positions, 1).unwrap(), &[1., 2., 3.]);
    for (buffer, index) in [(&positions[..], 2), (&positions[..], u32::MAX), (&positions[..2], 0), (&positions[..0], 0)] {
        assert!(canonical::corner_position(buffer, index).is_err());
    }
}

#[test]
fn issue_4243_target_vertex_pool_can_exceed_surviving_triangle_corner_count() {
    // Degenerate cleanup removes the first and last triangles, retaining unused vertices.
    let source = CONTROLLED_IFC
        .replace("#34=IFCTRIANGULATEDFACESET(#35,$,.F.,((1,2,3)),$);", "#34=IFCTRIANGULATEDFACESET(#35,$,.F.,((1,2,3),(4,5,6),(7,8,9)),$);")
        .replace("#35=IFCCARTESIANPOINTLIST3D(((0.,0.,5.),(1.,0.,5.),(0.,1.,5.)));", "#35=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1.,0.,0.),(2.,0.,0.),(0.,1.,0.),(1.,1.,0.),(0.,2.,0.),(10.,0.,0.),(11.,0.,0.),(12.,0.,0.)));")
        .replace("#36=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));", "#36=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(2.,0.),(0.,1.),(1.,1.),(0.,2.),(10.,0.),(11.,0.),(12.,0.)));")
        .replace("#37=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#34,#36,((3,2,1)));", "#37=IFCINDEXEDTRIANGLETEXTUREMAP((#20),#34,#36,((1,2,3),(4,5,6),(7,8,9)));");
    let plan = plan_appearance(source.as_bytes(), &request(vec![30])).unwrap();
    assert!(plan.exclusions.is_empty(), "{:?}", plan.exclusions);
    let item = &plan.items[0];
    assert_eq!(item.target_indices.len(), 3);
    assert!(item.target_indices.iter().any(|&i| i as usize >= item.target_indices.len()), "fixture must retain unused vertex slots: {:?}", item.target_indices);
    let reopened = crate::process_geometry(apply(&source, &plan).as_bytes());
    let mesh = reopened.meshes.iter().find(|m| m.express_id == 30).unwrap();
    assert_eq!(item.target_vertex_count, mesh.positions.len()/3);
    assert!(item.target_vertex_count > *item.target_indices.iter().max().unwrap() as usize + 1, "unused trailing vertices must also count");
    assert_eq!(item.target_indices, mesh.indices);
    assert!(item.target_indices.iter().all(|&i| (i as usize) < item.target_vertex_count));
}

#[test]
fn issue_4441_image_appearance_refuses_structural_image_uri_tokens() {
    for token in ["*", "$", "#123", ".ENUM.", " .lower_1. "] {
        let mut request = request(vec![10]);
        request.image_uri = token.into();
        assert!(plan_appearance(CONTROLLED_IFC.as_bytes(), &request).unwrap_err()
            .contains("Image URI is a reserved appearance wire token"));
    }
}
