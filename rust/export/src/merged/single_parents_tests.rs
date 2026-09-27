// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::ParentClaims;

/// #5727: an already-parented member is stripped and the rest of the rel is
/// kept; a rel whose members are all parented is not written.
#[test]
fn strips_parented_members_and_drops_an_emptied_rel() {
    let mut parents = ParentClaims::new(false);
    let first = "#37=IFCRELAGGREGATES('a',$,$,$,#23,(#30));".to_string();
    assert_eq!(parents.claim("IFCRELAGGREGATES", first.clone(), false), Some(first));
    let partial = "#1499=IFCRELAGGREGATES('b',$,$,$,#13,(#30,#1980));".to_string();
    assert_eq!(
        parents.claim("IFCRELAGGREGATES", partial, true).as_deref(),
        Some("#1499=IFCRELAGGREGATES('b',$,$,$,#13,(#1980));")
    );
    let redundant = "#1500=IFCRELAGGREGATES('c',$,$,$,#13,(#30,#1980));".to_string();
    assert_eq!(parents.claim("IFCRELAGGREGATES", redundant, true), None);
}

/// Without `dedupe` (the first model, a federated one) nothing is stripped,
/// but the members are still recorded for later models.
#[test]
fn records_without_stripping_when_not_deduping() {
    let mut parents = ParentClaims::new(false);
    let a = "#1=IFCRELAGGREGATES('a',$,$,$,#2,(#3));".to_string();
    let b = "#4=IFCRELAGGREGATES('b',$,$,$,#5,(#3));".to_string();
    assert_eq!(parents.claim("IFCRELAGGREGATES", a.clone(), false), Some(a));
    assert_eq!(parents.claim("IFCRELAGGREGATES", b.clone(), false), Some(b));
    let c = "#6=IFCRELAGGREGATES('c',$,$,$,#7,(#3));".to_string();
    assert_eq!(parents.claim("IFCRELAGGREGATES", c, true), None);
}

/// #5802 (#5726): the output schema decides which inverse a nest fills. In
/// IFC2X3 a nest shares `Decomposes` with an aggregation; in IFC4 it is `Nests`.
#[test]
fn a_nest_shares_decomposes_with_an_aggregation_only_in_ifc2x3() {
    let aggregation = "#1=IFCRELAGGREGATES('a',$,$,$,#2,(#3));";
    let nest = "#4=IFCRELNESTS('n',$,$,$,#5,(#3));";
    for (ifc2x3, nest_written) in [(true, false), (false, true)] {
        let mut parents = ParentClaims::new(ifc2x3);
        parents.claim("IFCRELAGGREGATES", aggregation.to_string(), false);
        let out = parents.claim("IFCRELNESTS", nest.to_string(), true);
        assert_eq!(out.is_some(), nest_written, "ifc2x3={ifc2x3}");
    }
    // A second nest parent is refused in both.
    for ifc2x3 in [true, false] {
        let mut parents = ParentClaims::new(ifc2x3);
        parents.claim("IFCRELNESTS", nest.to_string(), false);
        let again = "#6=IFCRELNESTS('m',$,$,$,#7,(#3));".to_string();
        assert_eq!(parents.claim("IFCRELNESTS", again, true), None, "ifc2x3={ifc2x3}");
    }
}

/// A relationship with no single-valued inverse passes through. (Containment
/// is claimed since #5923; see `tests/merged_single_inverses.rs`.)
#[test]
fn leaves_other_relationships_alone() {
    let mut parents = ParentClaims::new(false);
    let line = "#1=IFCRELASSOCIATESMATERIAL('a',$,$,$,(#3),#2);".to_string();
    for dedupe in [false, true] {
        assert_eq!(parents.claim("IFCRELASSOCIATESMATERIAL", line.clone(), dedupe), Some(line.clone()));
    }
}

/// #5923: an element is contained in one structure. The containment's list is
/// its FIRST argument (RelatedElements, 4), the reverse of a decomposition.
#[test]
fn a_contained_element_keeps_one_containment() {
    for ifc2x3 in [true, false] {
        let mut parents = ParentClaims::new(ifc2x3);
        let first = "#4=IFCRELCONTAINEDINSPATIALSTRUCTURE('a',$,$,$,(#3),#2);".to_string();
        parents.claim("IFCRELCONTAINEDINSPATIALSTRUCTURE", first, false);
        let later = "#14=IFCRELCONTAINEDINSPATIALSTRUCTURE('b',$,$,$,(#3,#13),#12);".to_string();
        assert_eq!(
            parents.claim("IFCRELCONTAINEDINSPATIALSTRUCTURE", later, true).as_deref(),
            Some("#14=IFCRELCONTAINEDINSPATIALSTRUCTURE('b',$,$,$,(#13),#12);"),
            "ifc2x3={ifc2x3}"
        );
    }
}
