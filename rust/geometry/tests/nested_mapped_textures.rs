// SPDX-License-Identifier: MPL-2.0
//! Derived invariant inputs: actual downloaded texture samples are extended
//! with explicit nested mappings. These are not claimed to be real authoring-
//! tool exports of nested texture occurrences. The oracle is the original
//! textured geometry under the stated affine transforms, not an output pin.
use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{build_texture_index, GeometryRouter, Mesh, TextureAttachment, TextureSource};
use std::sync::Arc;

fn fixture(kind: &str) -> Option<String> {
    let name = format!("buildingsmart/annex_e/tessellated-shape-with-style/tessellation-with-{kind}-texture.ifc");
    let source = ifc_lite_testkit::fixture_text(&name);
    if source.is_none() { eprintln!("skipping {kind} nested texture invariant: run pnpm fixtures"); }
    source
}
fn derived(mut source: String, far: bool) -> String {
    let [x, y, z] = if far { [5_000_000., 6_000_000., 7_000_000.] } else { [0.; 3] };
    let records = format!("
#10000=IFCLOCALPLACEMENT($,#45);
#10001=IFCCARTESIANPOINT((7.,11.,13.));
#10002=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#10004,#10005,#10001,1.,#10006);
#10003=IFCMAPPEDITEM(#44,#10002);
#10004=IFCDIRECTION((0.,1.,0.));#10005=IFCDIRECTION((-1.,0.,0.));#10006=IFCDIRECTION((0.,0.,1.));
#10007=IFCCARTESIANPOINT((3.,5.,2.));#10008=IFCAXIS2PLACEMENT3D(#10007,$,$);
#10009=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#10003));
#10010=IFCREPRESENTATIONMAP(#10008,#10009);
#10011=IFCCARTESIANPOINT(({a},{b},{c}));
#10012=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#10015,#10016,#10011,2.,#10006);
#10013=IFCMAPPEDITEM(#10010,#10012);
#10014=IFCMAPPEDITEM(#10010,#10017);
#10015=IFCDIRECTION((-1.,0.,0.));#10016=IFCDIRECTION((0.,-1.,0.));
#10017=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#10015,#10016,#10018,2.,#10006);
#10018=IFCCARTESIANPOINT(({d},{e},{f}));
#10030=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#10013,#10014));
#10031=IFCPRODUCTDEFINITIONSHAPE($,$,(#10030));
#11000=IFCBUILDINGELEMENTPROXY('nested-texture-derived',$,'Derived nested texture',$,$,#10000,#10031,$,$);
#10040=IFCSHAPEREPRESENTATION(#2,'Body','MappedRepresentation',(#10041,#10042));
#10041=IFCMAPPEDITEM(#44,#10002);#10042=IFCMAPPEDITEM(#44,#10002);
#10043=IFCPRODUCTDEFINITIONSHAPE($,$,(#10040));
#11001=IFCBUILDINGELEMENTPROXY('direct-texture-derived',$,'Derived repeated texture',$,$,#10000,#10043,$,$);
", a=x+17.,b=y+19.,c=z+23.,d=x+101.,e=y+103.,f=z+107.);
    // Append records to the DATA section, leaving the real texture bytes and
    // their authored geometry unchanged. The sample's ids stop well below ours.
    let end = source.rfind("ENDSEC;").expect("sample DATA section");
    source.insert_str(end, &records);
    source
}
fn bits(values: &[f32]) -> Vec<u32> { values.iter().map(|value| value.to_bits()).collect() }
fn attachment(actual: &TextureAttachment, original: &TextureAttachment) {
    assert_eq!(actual.texture_id, original.texture_id);
    match (&actual.source, &original.source) {
        (TextureSource::Decoded(actual), TextureSource::Decoded(original)) => {
            assert!(actual.width > 0 && actual.height > 0 && !actual.rgba.is_empty());
            assert_eq!(actual.rgba.len(), actual.width as usize * actual.height as usize * 4);
            assert_eq!((actual.width, actual.height, actual.repeat_s, actual.repeat_t),
                (original.width, original.height, original.repeat_s, original.repeat_t));
            assert_eq!(actual.rgba.as_slice(), original.rgba.as_slice());
        }
        (TextureSource::Image(actual), TextureSource::Image(original)) => {
            assert!(!actual.url.is_empty(), "an unresolved image still has a real nonempty attachment");
            assert_eq!((&actual.url, actual.repeat_s, actual.repeat_t),
                (&original.url, original.repeat_s, original.repeat_t));
        }
        _ => panic!("mapping changed the actual texture source kind"),
    }
}
fn world(mesh: &Mesh, vertex: &[f32], rtc: [f64; 3]) -> [f64; 3] {
    [0, 1, 2].map(|axis| vertex[axis] as f64 + mesh.origin[axis] + rtc[axis])
}
fn assert_nested(original: &Mesh, mapped: &Mesh, occurrence: usize, far: bool) {
    assert_eq!(mapped.indices.len(), original.indices.len(), "positive-determinant transforms preserve ordered triangles");
    assert_eq!(mapped.positions.len(), mapped.normals.len());
    let rtc = if far { [5_000_000., 6_000_000., 7_000_000.] } else { [0.; 3] };
    let shift = occurrence as f64 * 84.;
    // Inner Rz90 + (7,11,13), map origin +(3,5,2), outer
    // 2*Rz180 + (17,19,23), then occurrence two adds (84,84,84).
    let expected = |point: [f64; 3]| [2.*point[1]-3.+shift+rtc[0],
        -2.*point[0]-13.+shift+rtc[1], 2.*point[2]+53.+shift+rtc[2]];
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for (&source_index, &target_index) in original.indices.iter().zip(&mapped.indices) {
        let source = &original.positions[source_index as usize*3..][..3];
        let target = &mapped.positions[target_index as usize*3..][..3];
        let expected = expected(world(original, source, [0.; 3]));
        let actual = world(mapped, target, rtc);
        for axis in 0..3 {
            // Three f32 stores occur along the mapped path. This bound is below
            // one micrometre per metre of the sample's approximately 100m span.
            assert!((actual[axis]-expected[axis]).abs() < 3e-5,
                "axis {axis}: {actual:?} != transformed {expected:?}");
            min[axis] = min[axis].min(expected[axis]-rtc[axis]);
            max[axis] = max[axis].max(expected[axis]-rtc[axis]);
        }
    }
    for (&source_index, &target_index) in original.indices.iter().zip(&mapped.indices) {
        let source = &original.normals[source_index as usize*3..][..3];
        let target = &mapped.normals[target_index as usize*3..][..3];
        let expected = [source[1], -source[0], source[2]];
        for axis in 0..3 { assert!((target[axis]-expected[axis]).abs() < 2e-6); }
    }
    assert_eq!(mapped.rtc_applied, far);
    if far {
        assert_ne!(mapped.origin, [0.; 3], "far mapping retains a local f64 origin");
        for axis in 0..3 {
            assert!((mapped.origin[axis]-(min[axis]+max[axis])*0.5).abs() < 3e-5,
                "origin must track the transformed local AABB centre");
        }
    } else { assert_eq!(mapped.origin, [0.; 3]); }
    assert_eq!(mapped.local_to_world, Some([1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.]));
}
fn indexed_uv_bits(mesh: &Mesh, uvs: &[f32]) -> Vec<[u32; 2]> {
    assert_eq!(uvs.len(), mesh.positions.len()/3*2);
    mesh.indices.iter().map(|&index| {
        let offset = index as usize*2;
        [uvs[offset].to_bits(), uvs[offset+1].to_bits()]
    }).collect()
}
fn check(kind: &str) {
    let Some(source) = fixture(kind) else { return };
    let mut original_decoder = EntityDecoder::new(&source);
    let original_router = GeometryRouter::with_scale_and_local_frame(1., false);
    let textures = build_texture_index(source.as_bytes(), &mut original_decoder);
    assert!(textures.contains_key(&48), "actual sample texture index must be populated");
    let map = original_decoder.decode_by_id(44).unwrap();
    let original = original_router.process_representation_map_with_texture(&map, &mut original_decoder, &textures).unwrap();
    assert_eq!(original.len(), 1, "sample has one textured source");
    let (original_mesh, original_uvs, original_attachment) = &original[0];
    assert!(!original_mesh.is_empty() && !original_uvs.is_empty());
    assert_eq!(original_uvs.len(), original_mesh.positions.len()/3*2);
    let original_attachment = original_attachment.as_ref().expect("actual sample image payload");
    for far in [false, true] {
        let derived = derived(source.clone(), far);
        let mut decoder = EntityDecoder::new(&derived);
        let mut router = GeometryRouter::with_scale_and_local_frame(1., far);
        if far { router.set_rtc_offset((5_000_000.,6_000_000.,7_000_000.)); }
        router.enable_shared_mapped_item_cache(GeometryRouter::new_mapped_item_cache());
        // Arm both repeated sources. A nested-map source is not a single solid;
        // a direct textured solid is explicitly ineligible for don't-bake.
        router.enable_output_instancing(Arc::new([(44,(2,10041)),(10010,(2,10013))].into_iter().collect()));
        let textures = build_texture_index(derived.as_bytes(), &mut decoder);
        let product = decoder.decode_by_id(11000).unwrap();
        let mut first: Option<ifc_lite_geometry::SubMeshCollection> = None;
        for _ in 0..2 { // Warm repetition must retain every UV-bearing occurrence.
            let output = router.process_element_with_submeshes_textured(&product, &mut decoder, &textures).unwrap();
            assert_eq!(output.len(), 2);
            assert!(!output.ids_are_materials);
            for (occurrence, sub) in output.sub_meshes.iter().enumerate() {
                assert_eq!(sub.geometry_id, 48);
                assert!(!sub.mesh.is_empty() && sub.mesh.instance_meta.is_none());
                // Product placement welds the raw source and remaps indices.
                // Every ordered triangle corner must retain its authored UV bits.
                assert_eq!(indexed_uv_bits(&sub.mesh, sub.uvs.as_ref().expect("nested UV channel")),
                    indexed_uv_bits(original_mesh, original_uvs));
                attachment(sub.texture.as_ref().expect("nested texture attachment"), original_attachment);
                assert_nested(original_mesh, &sub.mesh, occurrence, far);
            }
            if let Some(previous) = &first {
                for (old, new) in previous.sub_meshes.iter().zip(&output.sub_meshes) {
                    assert_eq!(old.mesh.indices, new.mesh.indices);
                    assert_eq!(bits(&old.mesh.positions), bits(&new.mesh.positions));
                    assert_eq!(bits(&old.mesh.normals), bits(&new.mesh.normals));
                    assert_eq!(bits(old.uvs.as_ref().unwrap()), bits(new.uvs.as_ref().unwrap()));
                    assert_eq!(old.mesh.origin.map(f64::to_bits), new.mesh.origin.map(f64::to_bits));
                }
            } else { first = Some(output); }
        }
        let direct = decoder.decode_by_id(11001).unwrap();
        let output = router.process_element_with_submeshes_textured(&direct, &mut decoder, &textures).unwrap();
        assert_eq!(output.len(), 2);
        for sub in output.sub_meshes {
            assert!(!sub.mesh.is_empty(), "repeated textured source must never become an empty instance placeholder");
            assert!(sub.mesh.instance_meta.is_none());
            assert_eq!(sub.mesh.indices.len(), original_mesh.indices.len());
            assert_eq!(indexed_uv_bits(&sub.mesh, sub.uvs.as_ref().expect("instance exclusion preserves UVs")),
                indexed_uv_bits(original_mesh, original_uvs));
            attachment(sub.texture.as_ref().expect("instance exclusion preserves attachment"), original_attachment);
        }
    }
}
#[test]
fn nested_pixel_texture_preserves_uv_pixels_transforms_and_instance_exclusion() { check("pixel"); }
#[test]
fn nested_blob_texture_preserves_uv_pixels_transforms_and_instance_exclusion() { check("blob"); }
#[test]
fn nested_image_texture_preserves_uv_reference_transforms_and_instance_exclusion() { check("image"); }
