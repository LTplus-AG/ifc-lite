// SPDX-License-Identifier: MPL-2.0
use super::*;
use crate::appearance::{page_source, source::Source, tests::CONTROLLED_IFC};

#[test]
fn appearance_passes_share_owned_maps_but_replacement_textures_have_a_new_revision() {
    let mut source = Source::new(CONTROLLED_IFC.as_bytes()).unwrap();
    let styles = page_source::appearance(CONTROLLED_IFC.as_bytes(), &mut source);
    let textures = source.texture_index(CONTROLLED_IFC.as_bytes());
    let original = styles.context(&source.production_model, source.production_identity, &textures);
    let before = produce(&mut source, 10, &textures, Some(&styles)).unwrap();
    let other = produce(&mut source, 30, &textures, Some(&styles)).unwrap();
    let same = styles.context(&source.production_model, source.production_identity, &textures);
    assert_eq!(original.id(), same.id());
    assert_eq!((before.len(), other.len()), (1, 1));
    assert_eq!((before[0].indices.len(), other[0].indices.len()), (12, 3));
    for mesh in before.iter().chain(&other) {
        assert_eq!(mesh.uvs.as_ref().unwrap().len(), mesh.positions.len() / 3 * 2);
        assert!(mesh.texture.is_some());
    }
    let mut replacement = textures[&14].clone();
    replacement.texture = TextureSource::Image(ImageTextureRef {
        url: "appearance/replacement.png".into(), repeat_s: false, repeat_t: true,
    });
    for uv in &mut replacement.tex_coords { uv[0] += 2.; uv[1] *= 3.; }
    let replacement = Arc::new(FxHashMap::from_iter([(14, replacement)]));
    let target = styles.snapshot(&source.production_model, &replacement);
    assert_ne!(original.id(), target.id());
    let a = original.borrowed();
    let b = target.borrowed();
    assert!(std::ptr::eq(a.geometry_style_index, b.geometry_style_index));
    assert!(std::ptr::eq(a.void_index, b.void_index));
    assert!(!std::ptr::eq(a.texture_index, b.texture_index));
    let after = produce_with_context(&mut source, 10, &target, true, false).unwrap();
    assert_eq!(before[0].indices.len(), after[0].indices.len());
    for (&old, &new) in before[0].indices.iter().zip(&after[0].indices) {
        assert_eq!(corner_position(&before[0].positions, old).unwrap(),
            corner_position(&after[0].positions, new).unwrap());
    }
    assert_eq!(before[0].color, after[0].color);
    assert_ne!(before[0].uvs, after[0].uvs);
    assert_ne!(before[0].texture.as_ref().unwrap().url, after[0].texture.as_ref().unwrap().url);
    // Target production must not freeze the next source pass to target UVs.
    let again = produce(&mut source, 10, &textures, Some(&styles)).unwrap();
    assert_eq!(before[0].uvs, again[0].uvs);
    assert_eq!(before[0].texture.as_ref().unwrap().url, again[0].texture.as_ref().unwrap().url);
}

#[test]
fn appearance_style_edits_rebuild_the_snapshot_after_completed_geometry_without_map_copy() {
    let mut source = Source::new(CONTROLLED_IFC.as_bytes()).unwrap();
    let mut styles = page_source::appearance(CONTROLLED_IFC.as_bytes(), &mut source);
    let textures = source.texture_index(CONTROLLED_IFC.as_bytes());
    let before = produce(&mut source, 10, &textures, Some(&styles)).unwrap();
    let old = styles.context(&source.production_model, source.production_identity, &textures).id();
    styles.insert_style(14, crate::style::GeometryStyleInfo::from_color([0., 0., 1., 1.]));
    let after = produce(&mut source, 10, &textures, Some(&styles)).unwrap();
    let new = styles.context(&source.production_model, source.production_identity, &textures).id();
    assert_ne!(old, new);
    assert_ne!(before[0].color, after[0].color);
    assert_eq!(after[0].color, [0., 0., 1., 1.]);
    assert_eq!(before[0].positions, after[0].positions);
    assert_eq!(before[0].indices, after[0].indices);
    assert_eq!(before[0].uvs, after[0].uvs);
}
