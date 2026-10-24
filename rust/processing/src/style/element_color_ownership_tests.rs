// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::resolve_element_color;
use crate::element::representation_map_style_source;
use ifc_lite_core::{build_entity_index, EntityDecoder};
use rustc_hash::FxHashMap;

const SOURCE: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Colour lookup ownership regression #7782'),'2;1');
FILE_NAME('test','2026-10-23',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('w',$,'Wall',$,$,$,#2,$,.NOTDEFINED.);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3));
#3=IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#4));
#4=IFCMAPPEDITEM(#5,$);
#5=IFCREPRESENTATIONMAP($,#6);
#6=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#7));
#7=IFCBLOCK($,1.,1.,1.);
ENDSEC;
END-ISO-10303-21;
"#;

// #7782: these are intentionally wrong-class positional carriers, not valid
// IFC geometry. Colour lookup historically tolerates them; geometry admission
// remains separate. The resolver must reach the authored item, not the
// element fallback, in debug as well as release builds.
#[test]
fn issue_7782_wrong_class_colour_carriers_resolve_the_direct_colour() {
    let replacements = [
        ("IFCPRODUCTDEFINITIONSHAPE($,$,(#3))", "IFCCARTESIANPOINT($,$,(#3))"),
        ("IFCSHAPEREPRESENTATION($,'Body','MappedRepresentation',(#4))",
         "IFCCARTESIANPOINT($,'Body','MappedRepresentation',(#4))"),
        ("IFCREPRESENTATIONMAP($,#6)", "IFCCARTESIANPOINT($,#6)"),
        ("IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#7))",
         "IFCCARTESIANPOINT($,'Body','SweptSolid',(#7))"),
    ];
    let direct = [0.1, 0.8, 0.2, 1.0];
    let fallback = [0.8, 0.1, 0.2, 1.0];
    for source in std::iter::once(SOURCE.to_owned()).chain(
        replacements.into_iter().map(|(from, to)| SOURCE.replace(from, to)),
    ) {
        let styles = FxHashMap::from_iter([(1, fallback), (7, direct)]);
        let mut decoder = EntityDecoder::with_index(&source, build_entity_index(&source));
        let wall = decoder.decode_by_id(1).expect("wall");
        assert_eq!(
            resolve_element_color(&wall, &styles, &mut decoder),
            Some(direct)
        );
    }
}

#[test]
fn issue_7782_type_product_colour_keeps_element_fallback() {
    let source = SOURCE.replace(
        "IFCWALL('w',$,'Wall',$,$,$,#2,$,.NOTDEFINED.)",
        "IFCWALLTYPE('w',$,'Wall type',$,$,$,(#5),$,$,.NOTDEFINED.)",
    );
    let mut decoder = EntityDecoder::with_index(&source, build_entity_index(&source));
    let entity = decoder.decode_by_id(1).expect("type product");
    let fallback = [0.8, 0.1, 0.2, 1.0];
    let styles = FxHashMap::from_iter([(1, fallback), (7, [0.1, 0.8, 0.2, 1.0])]);
    // The type map really reaches competing geometry; fallback must not pass
    // merely because the map is absent or its authored colour is unreachable.
    assert_eq!(
        representation_map_style_source(5, &|id| styles.contains_key(&id), &mut decoder),
        Some(7),
    );
    assert_eq!(resolve_element_color(&entity, &styles, &mut decoder), Some(fallback));
}
