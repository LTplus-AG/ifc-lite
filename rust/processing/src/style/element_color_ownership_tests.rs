// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::resolve_element_color;
use crate::element::product_shape_style_source;
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
// remains separate. Both native source lookup and the browser adapter must
// reach the same authored item in debug as well as release builds.
#[test]
fn issue_7782_wrong_class_colour_carriers_preserve_native_lookup() {
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
        let mut native = EntityDecoder::with_index(&source, build_entity_index(&source));
        assert_eq!(product_shape_style_source(2, &|id| styles.contains_key(&id), &mut native), Some(7));
        let mut browser = EntityDecoder::with_index(&source, build_entity_index(&source));
        let wall = browser.decode_by_id(1).expect("wall");
        assert_eq!(resolve_element_color(&wall, &styles, &mut browser), Some(direct));
    }
}

#[test]
fn issue_7782_type_product_colour_keeps_element_fallback() {
    let source = SOURCE.replace(
        "IFCWALL('w',$,'Wall',$,$,$,#2,$,.NOTDEFINED.)",
        "IFCWALLTYPE('w',$,'Wall type',$,$,$,(#20),(#5),$,$,.NOTDEFINED.)",
    );
    let mut decoder = EntityDecoder::with_index(&source, build_entity_index(&source));
    let entity = decoder.decode_by_id(1).expect("type product");
    let fallback = [0.8, 0.1, 0.2, 1.0];
    let styles = FxHashMap::from_iter([(1, fallback), (7, [0.1, 0.8, 0.2, 1.0])]);
    assert_eq!(resolve_element_color(&entity, &styles, &mut decoder), Some(fallback));
}
