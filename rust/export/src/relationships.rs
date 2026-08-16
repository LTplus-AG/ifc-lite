// SPDX-License-Identifier: MPL-2.0
//! Connections IFC keeps in relationship entities rather than on the products.
//!
//! [`EntityRow`](crate::EntityRow) describes one product on its own: its class,
//! identity, name, and the property and quantity sets attached to it. What it
//! cannot describe is how products relate to each other, because IFC models
//! those as separate objectified relationships (`IfcRelAggregates`,
//! `IfcRelContainedInSpatialStructure`, `IfcRelDefinesByType`). Those are not
//! products, so they never appear in the row stream, and a consumer that wants
//! the spatial tree or an occurrence's type has nowhere to get it.
//!
//! This resolves all three in one scan. A caller that wants only the spatial
//! half pays for the type half as well, which is one extra match arm over the
//! same pass and cheaper than a second traversal.

use std::collections::HashMap;

use ifc_lite_core::{EntityDecoder, EntityScanner};

/// Relationships resolved from one pass over the file.
#[derive(Debug, Clone, Default)]
pub struct Relationships {
    /// Spatial parent to its children, from `IfcRelAggregates` and
    /// `IfcRelContainedInSpatialStructure` together.
    ///
    /// Both are edges in the same tree: aggregation composes the spatial
    /// structure (project to site to building to storey), containment attaches
    /// elements to the storey that holds them. A consumer walking a hierarchy
    /// wants them merged, which is why they are not reported separately.
    pub spatial_children: HashMap<u32, Vec<u32>>,
    /// The first `IfcProject`, which is the root of that tree. `None` for a file
    /// that declares none, which is malformed but occurs.
    pub project: Option<u32>,
    /// An occurrence to the type object it is defined by, from
    /// `IfcRelDefinesByType`.
    ///
    /// One type defines many occurrences, so the map is keyed by occurrence: it
    /// answers "what is this?" for a product in hand, which is the direction a
    /// consumer asks in.
    pub type_of: HashMap<u32, u32>,
}

/// Resolve the relationships in `content`.
///
/// Malformed relationships are skipped rather than failing the scan: a file with
/// one dangling reference still has a usable tree, and the alternative is
/// returning nothing for a defect the caller cannot act on.
pub fn relationships(content: &[u8]) -> Relationships {
    // No entity index, deliberately. Every decode below is `decode_at_with_id`
    // over the scanner's own spans; only `decode_by_id` consults an index, and
    // nothing here calls it. Building one costs a full extra scan whose result
    // is never read: ~57 ms of a 235 ms call on a 327 MB model. Do not add one
    // back without a `decode_by_id` to justify it.
    let mut decoder = EntityDecoder::new(content);
    let mut out = Relationships::default();

    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        match type_name {
            "IFCPROJECT" => out.project = out.project.or(Some(id)),
            // IfcRelAggregates: RelatingObject(4), RelatedObjects(5, list)
            "IFCRELAGGREGATES" => {
                if let Ok(rel) = decoder.decode_at_with_id(id, start, end) {
                    if let Some(parent) = rel.get(4).and_then(|a| a.as_entity_ref()) {
                        if let Some(list) = rel.get(5).and_then(|a| a.as_list()) {
                            for c in list {
                                if let Some(cid) = c.as_entity_ref() {
                                    out.spatial_children.entry(parent).or_default().push(cid);
                                }
                            }
                        }
                    }
                }
            }
            // IfcRelContainedInSpatialStructure: RelatedElements(4, list), RelatingStructure(5)
            "IFCRELCONTAINEDINSPATIALSTRUCTURE" => {
                if let Ok(rel) = decoder.decode_at_with_id(id, start, end) {
                    if let Some(parent) = rel.get(5).and_then(|a| a.as_entity_ref()) {
                        if let Some(list) = rel.get(4).and_then(|a| a.as_list()) {
                            for c in list {
                                if let Some(cid) = c.as_entity_ref() {
                                    out.spatial_children.entry(parent).or_default().push(cid);
                                }
                            }
                        }
                    }
                }
            }
            // IfcRelDefinesByType: RelatedObjects(4, list), RelatingType(5)
            "IFCRELDEFINESBYTYPE" => {
                if let Ok(rel) = decoder.decode_at_with_id(id, start, end) {
                    if let Some(ty) = rel.get(5).and_then(|a| a.as_entity_ref()) {
                        if let Some(list) = rel.get(4).and_then(|a| a.as_list()) {
                            for o in list {
                                if let Some(oid) = o.as_entity_ref() {
                                    out.type_of.insert(oid, ty);
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A project, a storey aggregated under it, a wall contained in the storey,
    /// and a wall type defining that wall.
    const FILE: &[u8] = br#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('rel.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('p',$,'P',$,$,$,$,$,$);
#2=IFCBUILDINGSTOREY('s',$,'S',$,$,$,$,$,.ELEMENT.,0.);
#3=IFCWALL('w',$,'W',$,$,$,$,$,.STANDARD.);
#4=IFCWALLTYPE('t',$,'T',$,$,$,$,$,$,.STANDARD.);
#10=IFCRELAGGREGATES('a',$,$,$,#1,(#2));
#11=IFCRELCONTAINEDINSPATIALSTRUCTURE('c',$,$,$,(#3),#2);
#12=IFCRELDEFINESBYTYPE('d',$,$,$,(#3),#4);
ENDSEC;
END-ISO-10303-21;
"#;

    #[test]
    fn aggregation_and_containment_land_in_one_tree() {
        let r = relationships(FILE);
        assert_eq!(r.project, Some(1));
        assert_eq!(r.spatial_children.get(&1).map(Vec::as_slice), Some(&[2u32][..]));
        assert_eq!(r.spatial_children.get(&2).map(Vec::as_slice), Some(&[3u32][..]));
    }

    #[test]
    fn an_occurrence_finds_its_type() {
        let r = relationships(FILE);
        assert_eq!(r.type_of.get(&3), Some(&4));
        assert_eq!(
            r.type_of.get(&4),
            None,
            "the map is keyed by occurrence, not by type"
        );
    }

    /// A file with no relationships is empty, not a failure. Plenty of real
    /// files carry only geometry.
    #[test]
    fn a_file_without_relationships_yields_nothing() {
        let bare = br#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('b.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCWALL('w',$,'W',$,$,$,$,$,.STANDARD.);
ENDSEC;
END-ISO-10303-21;
"#;
        let r = relationships(bare);
        assert!(r.spatial_children.is_empty());
        assert!(r.type_of.is_empty());
        assert_eq!(r.project, None);
    }

    /// A dangling reference must not take the rest of the tree with it.
    #[test]
    fn a_dangling_relationship_does_not_lose_the_others() {
        let mut broken = String::from_utf8(FILE.to_vec()).expect("ascii");
        // Point the containment at a storey that does not exist.
        broken = broken.replace(
            "#11=IFCRELCONTAINEDINSPATIALSTRUCTURE('c',$,$,$,(#3),#2);",
            "#11=IFCRELCONTAINEDINSPATIALSTRUCTURE('c',$,$,$,(#3),#999);",
        );
        let r = relationships(broken.as_bytes());
        assert_eq!(
            r.spatial_children.get(&1).map(Vec::as_slice),
            Some(&[2u32][..]),
            "the aggregation edge is independent of the broken containment"
        );
        assert_eq!(r.type_of.get(&3), Some(&4));
    }
}
