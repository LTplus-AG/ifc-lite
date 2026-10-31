// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #8291: authored face sets publish source-exact triangles through the real
//! controller; only cuts and copies ask the live worker for a stitched solid.
mod support;
use ifc_lite_retained_native::oracle::face_sets;

const F_B_MAPPED: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-b-mapped.ifc");

const SCAFFOLD: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#9=IFCLOCALPLACEMENT($,#5);
#20=IFCBUILDINGELEMENTPROXY('s',$,'Set',$,$,#9,#21,$,.NOTDEFINED.);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#33));
/*BODY*/
ENDSEC;END-ISO-10303-21;";
fn model(records: &str) -> String { SCAFFOLD.replace("/*BODY*/", records) }

#[test]
fn issue_8291_f_b_mapped_uncut_boxes_are_final_and_keyed_per_row() {
    let Some(outcomes) = support::native(F_B_MAPPED) else { return; };
    for id in [53, 68, 113, 172, 183] {
        let product = support::shape(&outcomes, id);
        assert_eq!(product.marker(), "final", "#{id}");
        let [part] = product.parts.as_slice() else { panic!("#{id} parts") };
        assert_eq!(part.indices.len(), 36, "twelve authored triangles");
        let faces = part.faces.as_ref().expect("face keys");
        assert_eq!(faces.table.len(), 12, "#{id}: one key per authored row, even coplanar ones");
        assert!(faces.table.iter().all(|key| key.role.starts_with("row(")));
        assert!(!part.curved && part.normals.is_some() && part.appearance.is_some());
    }
    println!("sdk witness executed: face_set_f_b_mapped");
}

#[test]
fn issue_8291_open_polygonal_sheet_with_a_hole_publishes_its_authored_rows() {
    // No closed solid exists for the kernel to build: this can only publish source triangles.
    let text = model("\
#30=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(4000.,0.,0.),(4000.,4000.,0.),(0.,4000.,0.),(1000.,1000.,0.),(2000.,1000.,0.),(2000.,2000.,0.),(1000.,2000.,0.),(0.,0.,3000.)));
#31=IFCINDEXEDPOLYGONALFACEWITHVOIDS((1,2,3,4),((5,8,7,6)));
#32=IFCINDEXEDPOLYGONALFACE((1,9,2));
#33=IFCPOLYGONALFACESET(#30,.F.,(#31,#32),$);");
    let Some(outcomes) = support::native(&text) else { return; };
    let product = support::shape(&outcomes, 20);
    assert_eq!(product.marker(), "final");
    let [part] = product.parts.as_slice() else { panic!("parts") };
    let faces = part.faces.as_ref().unwrap();
    let keys: Vec<_> = faces.triangles.iter().map(|&k| faces.table[k as usize].role.trim_start_matches("row(").trim_end_matches(')').parse::<u32>().ok()).collect();
    let mut decoder = ifc_lite_core::EntityDecoder::new(text.as_bytes());
    let item = decoder.decode_by_id(33).unwrap();
    let set = face_sets::authored(&item, &mut decoder, 0.001).unwrap();
    let deviation = face_sets::deviation(&set, &part.positions, &part.indices, &keys);
    assert_eq!(deviation.missing_rows, 0);
    assert!(deviation.corner_m <= 1e-9 && deviation.area_relative <= 1e-9, "{deviation:?}");
    println!("sdk witness executed: face_set_open_polygonal");
}

#[test]
fn issue_8291_survey_scale_coordinates_keep_full_precision() {
    // At this magnitude f32 rounds to 0.5 m: an authored 125 mm edge would collapse or move.
    let text = model("\
#30=IFCCARTESIANPOINTLIST3D(((6000000.,2000000.,0.),(6000000.125,2000000.,0.),(6000000.,2000000.125,0.)));
#33=IFCTRIANGULATEDFACESET(#30,$,.F.,((1,2,3)),$);").replace("IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)", "IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)");
    let Some(outcomes) = support::native(&text) else { return; };
    let [part] = support::shape(&outcomes, 20).parts.as_slice() else { panic!("parts") };
    let frame = part.world_from_object;
    let origin = [frame[12], frame[13]];
    assert_eq!(origin, [6000000., 2000000.], "the anchor carries the survey offset in f64");
    let span = part.positions.chunks_exact(3).map(|p| p[0]).fold(0., f64::max);
    assert_eq!(span, 0.125);
    println!("sdk witness executed: face_set_survey_scale");
}

#[test]
fn issue_8291_a_row_of_only_slivers_still_publishes_unit_normals() {
    // Real tessellations carry these: nonzero area, but below the facet-orientation ratio.
    let text = model("\
#30=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1000.,0.,0.),(500.,0.00001,0.),(0.,1000.,0.),(1000.,1000.,0.)));
#33=IFCTRIANGULATEDFACESET(#30,$,.F.,((1,2,3),(1,2,5),(1,5,4)),$);");
    let Some(outcomes) = support::native(&text) else { return; };
    let product = support::shape(&outcomes, 20);
    assert_eq!(product.marker(), "final");
    let [part] = product.parts.as_slice() else { panic!("parts") };
    assert_eq!(part.indices.len(), 9);
    for normal in part.normals.as_ref().unwrap().chunks_exact(3) {
        let length = (normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]).sqrt();
        assert!((length - 1.).abs() < 1e-12, "{normal:?}");
    }
    println!("sdk witness executed: face_set_sliver_row");
}

/// World volume and centroid, by the divergence theorem over published triangles.
fn world_moments(product: &ifc_lite_retained_native::ShapeOnlyProduct) -> (f64, [f64; 3]) {
    let (mut volume, mut moment) = (0., [0.; 3]);
    for part in &product.parts {
        let m = part.world_from_object;
        let point = |i: u32| -> [f64; 3] {
            let p = &part.positions[i as usize * 3..i as usize * 3 + 3];
            std::array::from_fn(|r| m[r] * p[0] + m[r + 4] * p[1] + m[r + 8] * p[2] + m[r + 12])
        };
        for t in part.indices.chunks_exact(3) {
            let [a, b, c] = [point(t[0]), point(t[1]), point(t[2])];
            let v = (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6.;
            volume += v;
            for i in 0..3 { moment[i] += v * (a[i] + b[i] + c[i]) / 4.; }
        }
    }
    (volume, moment.map(|value| value / volume))
}

#[test]
fn issue_8291_cuts_land_where_the_fixture_says_and_keep_row_keys() {
    let Some(outcomes) = support::native(F_B_MAPPED) else { return; };
    // oracles.json: 5 m3, local centroids (1.1,0.5,1.6) and (0.9,0.5,1.6), rotated +90 about Z at x=30.
    for (id, centroid) in [(128, [26.1, 0.5, 1.6]), (153, [29.5, 0.9, 1.6])] {
        let product = support::shape(&outcomes, id);
        assert_eq!((product.marker(), product.cuts), ("final", 1), "#{id}");
        let (volume, actual) = world_moments(product);
        assert!((volume - 5.).abs() < 1e-9, "#{id} volume {volume}");
        for i in 0..3 { assert!((actual[i] - centroid[i]).abs() < 1e-9, "#{id} centroid {actual:?}"); }
        let [part] = product.parts.as_slice() else { panic!("#{id} parts") };
        assert!(!part.source_exact, "#{id} is the kernel's cut, not authored triangles");
        let faces = part.faces.as_ref().expect("face keys");
        assert!(faces.table.iter().any(|key| key.role.starts_with("row(")), "#{id} keeps authored rows");
    }
    println!("sdk witness executed: face_set_cuts");
}

#[test]
fn issue_8291_mirrored_and_nonuniform_copies_publish_outward() {
    let Some(outcomes) = support::native(F_B_MAPPED) else { return; };
    for id in [83, 98] {
        let product = support::shape(&outcomes, id);
        assert_eq!(product.marker(), "final", "#{id}");
        let (volume, _) = world_moments(product);
        assert!((volume - 6.).abs() < 1e-9, "#{id} signed volume {volume}: outward winding, determinant one");
        assert!(product.parts.iter().all(|part| !part.source_exact));
    }
    println!("sdk witness executed: face_set_affine");
}

#[test]
fn issue_8291_open_shell_operands_refuse_typed_and_spend_no_worker() {
    // More cut open sheets than the restart budget: no closed solid exists for any of them.
    let Some(worker) = support::worker_path() else { return; };
    let mut records = String::new();
    for i in 0..6 {
        let base = 100 + i * 10;
        records.push_str(&format!("#{a}=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(4000.,0.,0.),(4000.,4000.,0.),(0.,4000.,0.)));
#{b}=IFCTRIANGULATEDFACESET(#{a},$,.F.,((1,2,3),(1,3,4)),$);
#{c}=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#{b},#44);
#{d}=IFCSHAPEREPRESENTATION(#2,'Body','Clipping',(#{c}));#{e}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{d}));
#{f}=IFCBUILDINGELEMENTPROXY('o{i}',$,'Open',$,$,#9,#{e},$,.NOTDEFINED.);\n",
            a = base, b = base + 1, c = base + 2, d = base + 3, e = base + 4, f = base + 5));
    }
    let text = model(&format!("#30=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1000.,0.,0.),(0.,1000.,0.),(0.,0.,1000.)));
#33=IFCTRIANGULATEDFACESET(#30,$,.T.,((1,3,2),(1,2,4),(2,3,4),(3,1,4)),$);
#40=IFCCARTESIANPOINT((2000.,0.,0.));#41=IFCDIRECTION((1.,0.,0.));#42=IFCAXIS2PLACEMENT3D(#40,#41,$);
#43=IFCPLANE(#42);#44=IFCHALFSPACESOLID(#43,.F.);
{records}"));
    let mut outcomes = Vec::new();
    let summary = ifc_lite_retained_native::run_model_native(ifc_lite_core::SourceBundle::new(text.into_bytes()), &worker,
        &Default::default(), |outcome| outcomes.push(outcome)).unwrap();
    assert_eq!(summary.restarts, 0, "a source-decided refusal spends no worker");
    for id in [105, 115, 125, 135, 145, 155] {
        assert_eq!(support::refusal(&outcomes, id).code(), "operation_unsupported", "#{id}");
    }
    assert_eq!(support::shape(&outcomes, 20).marker(), "final", "the closed face set still publishes");
    println!("sdk witness executed: face_set_open_operand");
}

const F_T: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-t-face-set-presentation.ifc");
const NO_ENTRY: u32 = ifc_lite_processing::element::retained_runtime::NO_PALETTE_ENTRY;

/// (palette product, textured product) in the generator's order: uncut, then cut.
const F_T_PALETTE: [u32; 2] = [17, 38];
const F_T_TEXTURE: [u32; 2] = [28, 57];

#[test]
fn issue_8291_palette_index_is_the_source_rows_uncut_and_through_a_cut() {
    let Some(outcomes) = support::native(F_T) else { return; };
    let colour_index = [0u32, 1, 2, 0, 1, 2, 1, 2, 0, 2, 0, 1];
    for id in F_T_PALETTE {
        let product = support::shape(&outcomes, id);
        assert_eq!(product.marker(), "final", "#{id}");
        let [part] = product.parts.as_slice() else { panic!("#{id} parts") };
        let palette = part.surface.as_ref().and_then(|s| s.palette.as_ref()).expect("palette");
        assert_eq!(palette.colours.len(), 3);
        let faces = part.faces.as_ref().unwrap();
        let mut reveals = 0;
        for (t, &key) in faces.triangles.iter().enumerate() {
            match faces.table[key as usize].role.strip_prefix("row(").and_then(|r| r.strip_suffix(')')) {
                Some(row) => assert_eq!(palette.triangles[t], colour_index[row.parse::<usize>().unwrap()], "#{id} triangle {t}"),
                None => { reveals += 1; assert_eq!(palette.triangles[t], NO_ENTRY, "#{id}: a reveal has no palette row"); }
            }
        }
        assert_eq!(reveals > 0, product.cuts == 1, "#{id}: only the cut product has reveals");
    }
    println!("sdk witness executed: face_set_palette");
}

#[test]
fn issue_8291_every_corner_uv_is_the_rows_affine_map_uncut_and_through_a_cut() {
    let Some(outcomes) = support::native(F_T) else { return; };
    for id in F_T_TEXTURE {
        let product = support::shape(&outcomes, id);
        assert_eq!(product.marker(), "final", "#{id}");
        let [part] = product.parts.as_slice() else { panic!("#{id} parts") };
        let texture = part.surface.as_ref().and_then(|s| s.texture.as_ref()).expect("texture");
        let faces = part.faces.as_ref().unwrap();
        let mut decoder = ifc_lite_core::EntityDecoder::new(F_T.as_bytes());
        let item = decoder.decode_by_id(faces.table.iter().find(|k| k.role.starts_with("row(")).unwrap().item).unwrap();
        let set = face_sets::authored(&item, &mut decoder, 1.).unwrap();
        let authored = face_sets::authored_surface(F_T.as_bytes(), &item, &mut decoder);
        let source = authored.uvs.expect("authored UVs");
        let (mut compared, mut new_corners) = (0, 0);
        for (t, &key) in faces.triangles.iter().enumerate() {
            let Some(row) = faces.table[key as usize].role.strip_prefix("row(").and_then(|r| r.strip_suffix(')')) else {
                assert!(!texture.textured[t], "#{id}: a reveal has no authored UV");
                continue;
            };
            let row: usize = row.parse().unwrap();
            assert!(texture.textured[t]);
            for corner in 0..3 {
                let at = part.indices[t * 3 + corner] as usize * 3;
                let p = [part.positions[at], part.positions[at + 1], part.positions[at + 2]];
                let uv = [texture.uvs[(t * 3 + corner) * 2], texture.uvs[(t * 3 + corner) * 2 + 1]];
                let deviation = face_sets::uv_deviation(&set.rows[row], &source[row], p, uv).expect("row plane");
                assert!(deviation <= 1e-9, "#{id} row {row}: {deviation}");
                compared += 1;
                new_corners += usize::from(!set.rows[row].points.iter().any(|q| (0..3).all(|i| (q[i] - p[i]).abs() < 1e-12)));
            }
        }
        assert!(compared >= 36);
        assert_eq!(new_corners > 0, product.cuts == 1, "#{id}: a cut must have interpolated new corners");
    }
    println!("sdk witness executed: face_set_uv");
}

#[test]
fn issue_8291_stage_native_browser_reference() {
    let Some(outcomes) = support::native(F_T) else { return; };
    let bits = |values: &[f64]| values.iter().map(|v| v.to_bits().to_string()).collect::<Vec<_>>();
    let rows: Vec<_> = F_T_PALETTE.iter().chain(&F_T_TEXTURE).map(|&id| {
        let product = support::shape(&outcomes, id);
        let parts: Vec<_> = product.parts.iter().map(|part| {
            let surface = part.surface.as_ref().unwrap();
            serde_json::json!({
                "palette": surface.palette.as_ref().map(|p| &p.triangles),
                "uvBits": surface.texture.as_ref().map(|x| bits(&x.uvs)),
                "faces": part.faces.as_ref().map(|f| f.table.iter().map(|k| k.to_string()).collect::<Vec<_>>()),
            })
        }).collect();
        serde_json::json!({"id": id, "parts": parts})
    }).collect();
    if let Ok(path) = std::env::var("IFCLITE_M11T_REFERENCE") {
        std::fs::write(path, serde_json::to_vec(&rows).unwrap()).unwrap();
    }
    println!("sdk witness executed: face_set_reference");
}

#[test]
fn issue_8291_a_coloured_cutter_never_colours_the_host_or_its_reveals() {
    // An extruded wall whose opening's body is a face set with its own palette.
    let text = model("\
#33=IFCEXTRUDEDAREASOLID(#34,#5,#35,3000.);#34=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4000.,1000.);#35=IFCDIRECTION((0.,0.,1.));
#60=IFCCARTESIANPOINTLIST3D(((-500.,-1000.,500.),(500.,-1000.,500.),(500.,1000.,500.),(-500.,1000.,500.),(-500.,-1000.,1500.),(500.,-1000.,1500.),(500.,1000.,1500.),(-500.,1000.,1500.)));
#61=IFCTRIANGULATEDFACESET(#60,$,.T.,((1,3,2),(1,4,3),(5,6,7),(5,7,8),(1,2,6),(1,6,5),(2,3,7),(2,7,6),(3,4,8),(3,8,7),(4,1,5),(4,5,8)),$);
#62=IFCCOLOURRGBLIST(((1.,0.,0.),(0.,1.,0.)));#63=IFCINDEXEDCOLOURMAP(#61,1.,#62,(1,2,1,2,1,2,1,2,1,2,1,2));
#64=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#61));#65=IFCPRODUCTDEFINITIONSHAPE($,$,(#64));
#66=IFCOPENINGELEMENT('op',$,'o',$,$,#9,#65,$,.OPENING.);#67=IFCRELVOIDSELEMENT('r',$,$,$,#20,#66);");
    let Some(outcomes) = support::native(&text) else { return; };
    let host = support::shape(&outcomes, 20);
    assert_eq!((host.marker(), host.cuts), ("final", 1));
    let [part] = host.parts.as_slice() else { panic!("parts") };
    assert!(part.surface.is_none(), "the wall has no authored surface");
    let faces = part.faces.as_ref().unwrap();
    assert!(faces.table.iter().any(|key| key.via == 66), "the cut really has reveals");
    let colour = part.appearance.as_ref().unwrap().rgba;
    assert_ne!(colour[..3], [1., 0., 0.], "not the cutter's dominant entry");
    println!("sdk witness executed: face_set_coloured_cutter");
}
