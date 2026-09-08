// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Type-associated material fallback (split from `prepass.rs`): an
//! `IfcRelAssociatesMaterial` may target an `IfcTypeObject` (e.g.
//! `IfcWallType`) rather than an occurrence directly — authoring tools
//! commonly attach material at the type. `resolve_prepass`'s direct-
//! association loop already records that in `element_to_material` under the
//! TYPE's own express id (it's just another entry in `RelatedObjects`); this
//! pass gives every occurrence of that type the same material, UNLESS the
//! occurrence already has its own (occurrence overrides type — the same
//! precedence `resolveAllMaterialDefIds` uses on the TS side).

use ifc_lite_core::EntityDecoder;
use rustc_hash::FxHashMap;

use crate::prepass::{refs_from_list, Span};

/// Walk `defines_by_type` spans (`IFCRELDEFINESBYTYPE`) and, for every
/// occurrence whose type already has a resolved material, install that
/// material UNLESS the occurrence already has one of its own.
pub(crate) fn propagate_type_material(
    defines_by_type: &[Span],
    decoder: &mut EntityDecoder,
    element_to_material: &mut FxHashMap<u32, u32>,
) {
    for &(id, start, end) in defines_by_type {
        let Ok(entity) = decoder.decode_at_with_id(id, start, end) else {
            continue;
        };
        // IfcRelDefinesByType: RelatedObjects (attr 4), RelatingType (attr 5).
        let Some(type_id) = entity.get_ref(5) else {
            continue;
        };
        let Some(&type_material) = element_to_material.get(&type_id) else {
            continue;
        };
        let Some(occurrences) = refs_from_list(&entity, 4) else {
            continue;
        };
        for occurrence_id in occurrences {
            element_to_material.entry(occurrence_id).or_insert(type_material);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::prepass::{resolve_prepass, PrepassSpans, ResolveOptions};
    use ifc_lite_core::EntityScanner;

    /// A type-object `IfcRelAssociatesMaterial` (e.g. IfcWallType →
    /// Concrete) applies to every occurrence of that type via
    /// `IfcRelDefinesByType`, UNLESS the occurrence carries its own
    /// `IfcRelAssociatesMaterial` (occurrence overrides type). Before this
    /// fix `element_to_material` was built only from the direct
    /// `IfcRelAssociatesMaterial` loop, which records the association under
    /// the TYPE's own express id — never propagated to its occurrences, so
    /// a type-only-styled model rendered every such occurrence in the
    /// default type colour.
    #[test]
    fn resolve_prepass_falls_back_to_type_material_unless_occurrence_has_its_own() {
        const IFC: &[u8] = br#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('m.ifc','2026-09-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#10=IFCMATERIAL('Concrete',$,$);
#11=IFCMATERIAL('Steel',$,$);
#20=IFCWALLTYPE('t',$,'WT',$,$,$,$,$,$,$,$);
#21=IFCRELASSOCIATESMATERIAL('r1',$,$,$,(#20),#10);
#30=IFCWALL('w1',$,'TypeOnly',$,$,$,$,$,$);
#31=IFCRELDEFINESBYTYPE('d1',$,$,$,(#30),#20);
#40=IFCWALL('w2',$,'Overridden',$,$,$,$,$,$);
#41=IFCRELASSOCIATESMATERIAL('r2',$,$,$,(#40),#11);
#42=IFCRELDEFINESBYTYPE('d2',$,$,$,(#40),#20);
#50=IFCWALL('w3',$,'InstanceOnly',$,$,$,$,$,$);
#51=IFCRELASSOCIATESMATERIAL('r3',$,$,$,(#50),#11);
ENDSEC;
END-ISO-10303-21;
"#;
        let mut spans = PrepassSpans::default();
        let mut scanner = EntityScanner::new(IFC);
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            match type_name {
                "IFCRELASSOCIATESMATERIAL" => spans.rel_associates_material.push((id, start, end)),
                "IFCRELDEFINESBYTYPE" => spans.defines_by_type.push((id, start, end)),
                _ => {}
            }
        }

        let mut decoder = EntityDecoder::new(IFC);
        let resolved = resolve_prepass(&spans, &mut decoder, ResolveOptions::default());

        // RED (pre-fix): w1 (#30) had no entry at all — its type's material
        // was recorded under #20, never reached the occurrence.
        assert_eq!(
            resolved.element_to_material.get(&30),
            Some(&10),
            "occurrence with only a type-level material association must inherit it"
        );
        // Occurrence overrides type: w2 (#40) keeps its OWN material (#11 =
        // Steel), not the type's (#10 = Concrete) and not both.
        assert_eq!(
            resolved.element_to_material.get(&40),
            Some(&11),
            "an occurrence's own material association must win over its type's"
        );
        // Control: an instance-only association (no type in play) is
        // unaffected by the type-fallback pass.
        assert_eq!(resolved.element_to_material.get(&50), Some(&11));
    }
}
