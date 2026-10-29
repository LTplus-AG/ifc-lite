// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

// Regression coverage moved from the browser resolver for #7782.
#[cfg(test)]
mod resolve_element_color_tests {
    //! Locks in `resolve_element_color`'s precedence: direct
    //! `IfcStyledItem`-on-geometry-item wins over the element-keyed
    //! material-chain fallback that the streaming prepass folds into
    //! `geometry_styles`. The fallback exists so files that author colour
    //! **only** via the material chain (schependomlaan.ifc and most
    //! ArchiCAD/Revit IFC2x3 exports) stop rendering as default grey.
    use super::resolve_element_color;
    use ifc_lite_core::{build_entity_index, EntityDecoder};
    use rustc_hash::FxHashMap;

    /// Minimal IFC4 wall whose body is a single `IfcExtrudedAreaSolid`.
    /// Express IDs:
    ///   #1 wall, #2 product-def-shape, #3 shape-rep, #5 extrusion.
    /// Tests put colours under #1 (element-keyed material chain) and/or
    /// #5 (direct geometry-item) to exercise each resolution path.
    const WALL_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test','2026-05-27',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('w',$,'Wall',$,$,$,#2,$,.NOTDEFINED.);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#3=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#5));
#4=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#6,$);
#5=IFCEXTRUDEDAREASOLID(#7,#6,#8,3000.);
#6=IFCAXIS2PLACEMENT3D(#9,$,$);
#7=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,200.,4000.);
#8=IFCDIRECTION((0.,0.,1.));
#9=IFCCARTESIANPOINT((0.,0.,0.));
ENDSEC;
END-ISO-10303-21;
"#;

    fn decode_wall() -> (EntityDecoder<'static>, ifc_lite_core::DecodedEntity) {
        // Leak the content so the decoder can hold a 'static borrow — only
        // safe inside `#[cfg(test)]` and keeps the call sites tidy.
        let content: &'static str = Box::leak(WALL_IFC.to_string().into_boxed_str());
        let idx = build_entity_index(content);
        let mut decoder = EntityDecoder::with_index(content, idx);
        let wall = decoder.decode_by_id(1).expect("decode wall #1");
        (decoder, wall)
    }

    fn decode_wall_from(source: String) -> (EntityDecoder<'static>, ifc_lite_core::DecodedEntity) {
        let content: &'static str = Box::leak(source.into_boxed_str());
        let idx = build_entity_index(content);
        let mut decoder = EntityDecoder::with_index(content, idx);
        let wall = decoder.decode_by_id(1).expect("decode wall #1");
        (decoder, wall)
    }

    #[test]
    fn empty_geometry_styles_returns_none() {
        let (mut decoder, wall) = decode_wall();
        let styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
        assert_eq!(resolve_element_color(&wall, &styles, &mut decoder), None);
    }

    #[test]
    fn direct_geometry_item_color_resolves_via_rep_walk() {
        let (mut decoder, wall) = decode_wall();
        let mut styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
        // Colour keyed on the extrusion #5 — direct IfcStyledItem path.
        styles.insert(5, [0.1, 0.8, 0.2, 1.0]);
        assert_eq!(
            resolve_element_color(&wall, &styles, &mut decoder),
            Some([0.1, 0.8, 0.2, 1.0]),
        );
    }

    #[test]
    fn direct_color_walk_accepts_bare_representation_and_item_refs_4694() {
        let variants = [
            WALL_IFC.replace(
                "#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));",
                "#2=IFCPRODUCTDEFINITIONSHAPE($,$,#3);",
            ),
            WALL_IFC.replace(
                "#3=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',(#5));",
                "#3=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',#5);",
            ),
        ];
        for source in variants {
            let (mut decoder, wall) = decode_wall_from(source);
            let styles = FxHashMap::from_iter([(5, [0.1, 0.8, 0.2, 1.0])]);
            assert_eq!(
                resolve_element_color(&wall, &styles, &mut decoder),
                Some([0.1, 0.8, 0.2, 1.0]),
            );
        }
    }

    #[test]
    fn mapped_color_walk_accepts_a_bare_items_ref_4694() {
        let source = WALL_IFC
            .replace("(#5));", "(#10));")
            .replace(
                "#5=IFCEXTRUDEDAREASOLID",
                "#10=IFCMAPPEDITEM(#11,#12);\n#11=IFCREPRESENTATIONMAP(#6,#13);\n#12=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#9,1.,$);\n#13=IFCSHAPEREPRESENTATION(#4,'Body','SweptSolid',#5);\n#5=IFCEXTRUDEDAREASOLID",
            );
        let (mut decoder, wall) = decode_wall_from(source);
        let styles = FxHashMap::from_iter([(5, [0.1, 0.8, 0.2, 1.0])]);
        assert_eq!(
            resolve_element_color(&wall, &styles, &mut decoder),
            Some([0.1, 0.8, 0.2, 1.0]),
        );
    }

    #[test]
    fn element_id_keyed_material_color_resolves_via_fallback() {
        let (mut decoder, wall) = decode_wall();
        let mut styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
        // Colour keyed on the wall itself — material-chain fallback path
        // (prepass folds element_material_styles into geometry_styles
        // keyed by element express ID).
        styles.insert(1, [0.8, 0.2, 0.1, 1.0]);
        assert_eq!(
            resolve_element_color(&wall, &styles, &mut decoder),
            Some([0.8, 0.2, 0.1, 1.0]),
        );
    }

    #[test]
    fn direct_color_wins_over_material_fallback() {
        let (mut decoder, wall) = decode_wall();
        let mut styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
        // Both present — the IfcStyledItem on the extrusion must win per
        // IFC precedence. Inverting this order was the bug in the first
        // attempt at the fix (PR-reverted) and would silently override
        // direct authoring with material defaults.
        styles.insert(1, [0.8, 0.2, 0.1, 1.0]); // material → red
        styles.insert(5, [0.1, 0.8, 0.2, 1.0]); // direct  → green
        assert_eq!(
            resolve_element_color(&wall, &styles, &mut decoder),
            Some([0.1, 0.8, 0.2, 1.0]),
            "direct geometry-item colour must win over material fallback",
        );
    }

    #[test]
    fn unrelated_colors_yield_none() {
        let (mut decoder, wall) = decode_wall();
        let mut styles: FxHashMap<u32, [f32; 4]> = FxHashMap::default();
        // Unrelated express ID — neither the wall nor any item in its rep.
        styles.insert(999, [0.5, 0.5, 0.5, 1.0]);
        assert_eq!(resolve_element_color(&wall, &styles, &mut decoder), None);
    }
}

