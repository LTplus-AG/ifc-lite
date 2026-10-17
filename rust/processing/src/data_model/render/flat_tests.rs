// SPDX-License-Identifier: MPL-2.0
//! C6-7 (#7783): the flat exports read property sets through the shared
//! decoder; since D47 they write every property kind.

use std::sync::Arc;

use ifc_lite_core::{build_entity_index, EntityDecoder};
use crate::data_model::property::{PropertyDecoder, PropertyScope};

use super::{decode_property_set, EXPORT_PROPERTY_SCOPE};
use crate::data_model::rows::{PropValue, ValueKind};

const SYNTHETIC: &[u8] = include_bytes!("../../../../export/tests/fixtures/c6_data_model_synthetic.ifc");

fn flat(scope: PropertyScope, set_id: u32) -> Vec<PropValue> {
    let mut decoder = EntityDecoder::with_arc_index(SYNTHETIC, Arc::new(build_entity_index(SYNTHETIC)));
    let mut props = PropertyDecoder::for_input(SYNTHETIC.len(), scope);
    let def = decoder.decode_by_id(set_id).unwrap();
    decode_property_set(&mut props, &mut decoder, &def).expect("a property set").properties
}

fn row<'a>(props: &'a [PropValue], name: &str) -> (&'a str, &'a str, ValueKind) {
    let p = props.iter().find(|p| p.name == name).unwrap_or_else(|| panic!("no {name}"));
    (p.value.as_str(), p.value_type.as_str(), p.kind)
}

/// EXPORT-DATA-2 (D47): the flat exports write all ten properties of
/// `Pset_AllKinds` (#400), the four single values first and unchanged.
#[test]
fn the_export_scope_is_every_kind_d47() {
    assert_eq!(EXPORT_PROPERTY_SCOPE, PropertyScope::AllKinds);
    let props = flat(EXPORT_PROPERTY_SCOPE, 400);
    assert_eq!(props.len(), 10);
    assert_eq!(row(&props, "Flag"), ("true", "IFCBOOLEAN", ValueKind::Bool));
    assert_eq!(row(&props, "Unknown"), ("unknown", "IFCLOGICAL", ValueKind::Text));
    assert_eq!(row(&props, "Thickness"), ("0.2", "IFCPOSITIVELENGTHMEASURE", ValueKind::Number));
    assert_eq!(row(&props, "Status"), ("NEW, EXISTING", "IFCLABEL", ValueKind::Text));
}

/// What D47 writes for each kind: the columnar display string as text,
/// typed by the members' shared tag, else the class.
#[test]
fn all_kinds_render_the_columnar_display_string_as_text_d47() {
    let props = flat(PropertyScope::AllKinds, 400);
    assert_eq!(props.len(), 10);
    assert_eq!(row(&props, "Status"), ("NEW, EXISTING", "IFCLABEL", ValueKind::Text));
    assert_eq!(row(&props, "Sizes"), ("1, 2, 3", "IFCINTEGER", ValueKind::Text));
    assert_eq!(row(&props, "Range"), ("2 [1 \u{2013} 5]", "IFCLENGTHMEASURE", ValueKind::Text));
    assert_eq!(row(&props, "Curve"), ("Table (2 rows)", "IFCPROPERTYTABLEVALUE", ValueKind::Text));
    // The referenced object's Name (#30 is named "Target").
    assert_eq!(row(&props, "Ref"), ("Target", "IFCPROPERTYREFERENCEVALUE", ValueKind::Text));
    assert_eq!(row(&props, "Complex"), ("Inner1: a, Inner2: 2.5", "IFCCOMPLEXPROPERTY", ValueKind::Text));
    // The single values are unchanged by the wider scope.
    assert_eq!(props[..4], flat(PropertyScope::SingleValueOnly, 400)[..]);
}
