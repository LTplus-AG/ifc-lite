// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_core::{DecodedEntity, IfcType};
use std::collections::HashSet;

/// Item ids alone cannot distinguish two placements of a mapped fill or two
/// representations using the same item under different contexts. Certify only
/// one flat representation with unique direct items; unknown paths retain their
/// symbolic rendering rather than being suppressed by another occurrence.
pub(super) fn direct_fill_ids(items: &[DecodedEntity], single_representation: bool) -> HashSet<u32> {
    if !single_representation || items.iter().any(|item| !matches!(item.ifc_type,
        IfcType::IfcAnnotationFillArea | IfcType::IfcTextLiteral | IfcType::IfcTextLiteralWithExtent
        | IfcType::IfcPolyline | IfcType::IfcIndexedPolyCurve | IfcType::IfcCircle
        | IfcType::IfcEllipse | IfcType::IfcTrimmedCurve | IfcType::IfcLine)) {
        return HashSet::new();
    }
    let mut seen = HashSet::new();
    let mut repeated = HashSet::new();
    for item in items {
        if !seen.insert(item.id) { repeated.insert(item.id); }
    }
    items.iter().filter(|item| item.ifc_type == IfcType::IfcAnnotationFillArea
        && !repeated.contains(&item.id)).map(|item| item.id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use ifc_lite_core::{build_entity_index, EntityDecoder};

    #[test]
    fn issue_4459_unknown_or_repeated_occurrences_never_claim_direct_mesh_identity() {
        let source = b"#1=IFCANNOTATIONFILLAREA(#10,$);\n#2=IFCMAPPEDITEM(#20,#21);\n#3=IFCTEXTLITERAL('note',#30,.RIGHT.);";
        let mut decoder = EntityDecoder::with_index(source, build_entity_index(source));
        let fill = decoder.decode_by_id(1).unwrap();
        let mapped = decoder.decode_by_id(2).unwrap();
        let text = decoder.decode_by_id(3).unwrap();
        assert_eq!(direct_fill_ids(&[fill.clone(), text], true), HashSet::from([1]));
        assert!(direct_fill_ids(std::slice::from_ref(&fill), false).is_empty());
        assert!(direct_fill_ids(&[fill.clone(), fill.clone()], true).is_empty());
        assert!(direct_fill_ids(&[fill, mapped], true).is_empty());
    }
}
