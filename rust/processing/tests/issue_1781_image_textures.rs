// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Issue #1781 — `IfcImageTexture` (external image reference) on OCCURRENCE
//! geometry, the SketchUp IFC Manager / `.ifcZIP` export shape:
//!
//! - `IfcIndexedTriangleTextureMap` with a NULL `TexCoordIndex` (`$`): texture
//!   vertices pair 1:1 with the face set's `Coordinates`, so its `CoordIndex`
//!   doubles as the UV index.
//! - The texture is an `IfcImageTexture` whose `URLReference` names a sibling
//!   file; the pipeline ships the reference (`url` + `texture_id` + repeat
//!   flags), never decoded pixels — the host layer resolves and decodes once.
//! - The face sets are DIRECT items of a product's Body representation (not a
//!   type-product RepresentationMap), exercising the occurrence sub-mesh path.
//!
//! Two proxies share ONE image texture: #10 with `$` TexCoordIndex, #30 with
//! an explicit (reversing) TexCoordIndex — both must carry the SAME
//! `texture_id` so consumers create one GPU texture.

use ifc_lite_processing::process_geometry;

const IMAGE_TEXTURE_IFC: &str = r#"ISO-10303-21;
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

/// The authored per-coordinate UVs of face set #14 (1:1 with #15), as the
/// mesher stores them: V flipped to the GPU/glTF top-left origin.
const AUTHORED_UV: [[f32; 2]; 4] = [[0.0, 1.0], [1.0, 1.0], [0.0, 0.0], [1.0, 0.0]];

fn find_mesh(
    result: &ifc_lite_processing::ProcessingResult,
    id: u32,
) -> &ifc_lite_processing::MeshData {
    result
        .meshes
        .iter()
        .find(|m| m.express_id == id)
        .unwrap_or_else(|| {
            panic!(
                "element #{id} produced no mesh; got: {:?}",
                result
                    .meshes
                    .iter()
                    .map(|m| (m.express_id, m.ifc_type.as_str(), m.indices.len() / 3))
                    .collect::<Vec<_>>()
            )
        })
}

#[test]
fn image_texture_ships_reference_not_pixels() {
    let result = process_geometry(IMAGE_TEXTURE_IFC);
    let mesh = find_mesh(&result, 10);

    let tex = mesh
        .texture
        .as_ref()
        .expect("occurrence face set with an IfcImageTexture map should carry a texture");
    assert_eq!(tex.url.as_deref(), Some("textures/wood.jpg"), "URLReference verbatim");
    assert!(tex.rgba.is_none(), "image textures ship the reference, never pixels");
    assert_eq!(tex.texture_id, 20, "texture_id is the IfcImageTexture express id");
    assert!(tex.repeat_s, "RepeatS .T.");
    assert!(!tex.repeat_t, "RepeatT .F.");
}

#[test]
fn null_tex_coord_index_pairs_uvs_with_coordinates() {
    let result = process_geometry(IMAGE_TEXTURE_IFC);
    let mesh = find_mesh(&result, 10);

    let uvs = mesh.uvs.as_ref().expect("textured mesh carries UVs");
    assert_eq!(
        uvs.len(),
        (mesh.positions.len() / 3) * 2,
        "UVs are 2 floats per vertex, 1:1 with positions"
    );

    // With `$` TexCoordIndex, every output vertex's UV must equal the authored
    // UV of the COORDINATE it came from (1:1 pairing). Positions are stored
    // relative to the per-mesh origin; fold it back to match raw coordinates.
    let coords: [[f32; 3]; 4] = [
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
    ];
    let mut matched = 0usize;
    for v in 0..mesh.positions.len() / 3 {
        let p = [
            (mesh.origin[0] + mesh.positions[v * 3] as f64) as f32,
            (mesh.origin[1] + mesh.positions[v * 3 + 1] as f64) as f32,
            (mesh.origin[2] + mesh.positions[v * 3 + 2] as f64) as f32,
        ];
        let Some(ci) = coords
            .iter()
            .position(|c| c.iter().zip(p.iter()).all(|(a, b)| (a - b).abs() < 1e-5))
        else {
            panic!("vertex {v} at {p:?} matches no authored coordinate");
        };
        let expect = AUTHORED_UV[ci];
        let got = [uvs[v * 2], uvs[v * 2 + 1]];
        assert!(
            (got[0] - expect[0]).abs() < 1e-5 && (got[1] - expect[1]).abs() < 1e-5,
            "vertex {v} (coordinate {ci}) expected uv {expect:?}, got {got:?}"
        );
        matched += 1;
    }
    assert!(matched >= 4, "welded tetrahedron keeps at least its 4 corners");
}

#[test]
fn explicit_tex_coord_index_still_remaps_and_shares_texture_id() {
    let result = process_geometry(IMAGE_TEXTURE_IFC);
    let mesh = find_mesh(&result, 30);

    let tex = mesh.texture.as_ref().expect("explicit-index map should attach too");
    assert_eq!(
        tex.texture_id, 20,
        "both elements share the SAME texture_id (one GPU texture)"
    );

    // TexCoordIndex ((3,2,1)) reverses the pairing: the vertex at coordinate 1
    // (0,0,5) gets tex_coords[3-1] = (0,1) → V-flipped (0,0); coordinate 3
    // (0,1,5) gets tex_coords[1-1] = (0,0) → V-flipped (0,1).
    let uvs = mesh.uvs.as_ref().expect("textured mesh carries UVs");
    let mut checked = false;
    for v in 0..mesh.positions.len() / 3 {
        let p = [
            (mesh.origin[0] + mesh.positions[v * 3] as f64) as f32,
            (mesh.origin[1] + mesh.positions[v * 3 + 1] as f64) as f32,
            (mesh.origin[2] + mesh.positions[v * 3 + 2] as f64) as f32,
        ];
        if (p[0]).abs() < 1e-5 && (p[1]).abs() < 1e-5 && (p[2] - 5.0).abs() < 1e-4 {
            let got = [uvs[v * 2], uvs[v * 2 + 1]];
            assert!(
                got[0].abs() < 1e-5 && got[1].abs() < 1e-5,
                "corner (0,0,5) must sample the REVERSED uv (0,1)→flipped (0,0), got {got:?}"
            );
            checked = true;
        }
    }
    assert!(checked, "corner (0,0,5) not found in output mesh");
}

/// A voided textured element must not sample stale UVs: the CSG cut rebuilds
/// vertices, so the texture is dropped (renders with its style colour) rather
/// than mapped wrong. Locks the void-path `None` texture index (#1781).
#[test]
fn untextured_meshes_stay_untextured() {
    let result = process_geometry(IMAGE_TEXTURE_IFC);
    for mesh in &result.meshes {
        if mesh.express_id != 10 && mesh.express_id != 30 {
            assert!(
                mesh.texture.is_none() && mesh.uvs.is_none(),
                "mesh #{} unexpectedly textured",
                mesh.express_id
            );
        }
    }
}
