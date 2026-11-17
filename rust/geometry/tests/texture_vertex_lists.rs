// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The vertex-list sidecar names the very map the texture index kept, and
//! `ResolvedTextureMap` stays the literal 27.1.0 published: a field on it needs
//! a major of the Rust crates (`scripts/check-rust-semver.mjs`).

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{
    build_texture_index, build_texture_index_with_vertex_lists, ImageTextureRef,
    ResolvedTextureMap, TextureSource,
};

const MODEL: &str = "ISO-10303-21;\nDATA;\n\
    #1=IFCPIXELTEXTURE(.T.,.T.,'MODULATE',$,$,1,1,3,(\"0FF0000\"));\n\
    #2=IFCTEXTUREVERTEXLIST(((0.,0.),(1.,0.),(0.,1.)));\n\
    #3=IFCTEXTUREVERTEXLIST(((0.5,0.),(1.,0.5),(0.,1.)));\n\
    #4=IFCTEXTUREVERTEXLIST(((0.25,0.),(1.,0.25),(0.,1.)));\n\
    #5=IFCTEXTUREVERTEXLIST(());\n\
    #10=IFCINDEXEDTRIANGLETEXTUREMAP((#1),#20,#5,$);\n\
    #11=IFCINDEXEDTRIANGLETEXTUREMAP((#1),#20,#2,$);\n\
    #12=IFCINDEXEDTRIANGLETEXTUREMAP((#1),#20,#3,$);\n\
    #13=IFCINDEXEDTRIANGLETEXTUREMAP((#1),#21,#4,$);\n\
    ENDSEC;\nEND-ISO-10303-21;\n";

#[test]
fn the_vertex_list_is_the_one_the_kept_map_read() {
    let mut decoder = EntityDecoder::new(MODEL);
    let (index, lists) = build_texture_index_with_vertex_lists(MODEL.as_bytes(), &mut decoder);
    // #10 cannot resolve (an empty list) and #12 loses to the earlier #11.
    assert_eq!(lists.get(&20), Some(&2));
    assert_eq!(index[&20].tex_coords[0], [0., 0.]);
    assert_eq!(lists.get(&21), Some(&4));
    assert_eq!(lists.len(), index.len());

    let mut decoder = EntityDecoder::new(MODEL);
    let plain = build_texture_index(MODEL.as_bytes(), &mut decoder);
    assert_eq!(plain.len(), index.len());
    for (face_set, map) in &plain {
        assert_eq!(map.tex_coords, index[face_set].tex_coords);
        assert_eq!(map.tex_coord_index, index[face_set].tex_coord_index);
        assert_eq!(map.texture_id, index[face_set].texture_id);
    }
}

#[test]
fn a_27_1_0_literal_still_constructs() {
    let map = ResolvedTextureMap {
        texture_id: 1,
        texture: TextureSource::Image(ImageTextureRef {
            url: "a.png".into(),
            repeat_s: true,
            repeat_t: true,
        }),
        tex_coords: vec![[0., 0.]],
        tex_coord_index: None,
    };
    assert_eq!(map.attachment().texture_id, 1);
}
