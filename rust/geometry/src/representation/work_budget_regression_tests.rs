// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7873: total list work must be bounded independently of mapped-level count.
use super::*;

#[derive(Default)]
struct Work {
    entered: usize,
    left: usize,
    leaves: usize,
    refusals: Vec<String>,
}
impl WalkVisitor for Work {
    fn item(&mut self, _: &DecodedEntity, _: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
        self.leaves += 1;
        Flow::Continue
    }
    fn enter_map(&mut self, _: &MappedLevel, _: &WalkCtx<'_>, _: &mut EntityDecoder) -> Flow {
        self.entered += 1;
        Flow::Continue
    }
    fn leave_map(&mut self, _: &MappedLevel) { self.left += 1; }
    fn refused(&mut self, item: &DecodedEntity, why: WalkRefusal, _: &WalkCtx<'_>) {
        self.refusals.push(why.into_error(item.id).to_string());
    }
}

/// O(width) input with width occurrences of one width-leaf source. The same
/// mapped-item id on sibling paths is deliberate: each is a real occurrence.
fn wide_source(width: usize) -> String {
    let occurrences = vec!["#300"; width].join(",");
    let leaves = vec!["#1"; width].join(",");
    format!("#100=IFCREPRESENTATIONMAP($,#200);\
        #200=IFCSHAPEREPRESENTATION($,'Body','Brep',({occurrences}));\
        #300=IFCMAPPEDITEM(#400,$);#400=IFCREPRESENTATIONMAP($,#500);\
        #500=IFCSHAPEREPRESENTATION($,'Body','Brep',({leaves}));\
        #1=IFCCARTESIANPOINT((0.,0.,0.));")
}

#[test]
fn issue_7873_shared_wide_source_is_admitted_before_materialization_and_reports_once() {
    let width = 8;
    let model = wide_source(width);
    let mut decoder = EntityDecoder::new(&model);
    let root = decoder.decode_by_id(100).unwrap();
    let mut work = Work::default();
    RepresentationWalk { select: Select::Any, nested: NestedMaps::Expand {
        max_depth: 32, max_levels: width as u32,
    }}.map(&root, &mut decoder, &mut work).unwrap();
    // Root list consumed the allowance. Reject A's list before even decoding
    // its leaf; a late refusal after resolve_ref_list would still populate it.
    assert!(decoder.get_cached(1).is_none(), "unadmitted leaf was decoded");
    assert_eq!((work.entered, work.left, work.leaves), (1, 1, 0));
    assert_eq!(work.refusals.len(), 1, "bound AND report are required");
    assert!(work.refusals[0].contains("work budget"), "{:?}", work.refusals);
}

#[test]
fn issue_7873_shared_wide_source_keeps_every_occurrence_when_work_is_admitted() {
    let width = 8;
    let model = wide_source(width);
    let mut decoder = EntityDecoder::new(&model);
    let root = decoder.decode_by_id(100).unwrap();
    let mut work = Work::default();
    RepresentationWalk { select: Select::Any, nested: NestedMaps::Expand {
        max_depth: 32, max_levels: (width + width * width) as u32,
    }}.map(&root, &mut decoder, &mut work).unwrap();
    assert_eq!((work.entered, work.left, work.leaves), (width, width, width * width));
    assert!(work.refusals.is_empty(), "{:?}", work.refusals);
}

#[test]
fn issue_7873_root_list_budget_refuses_before_decoding_its_first_member() {
    let model = wide_source(8);
    let mut decoder = EntityDecoder::new(&model);
    let root = decoder.decode_by_id(100).unwrap();
    let mut work = Work::default();
    RepresentationWalk { select: Select::Any, nested: NestedMaps::Expand {
        max_depth: 32, max_levels: 7,
    }}.map(&root, &mut decoder, &mut work).unwrap();
    assert!(decoder.get_cached(300).is_none(), "root list was decoded before admission");
    assert_eq!((work.entered, work.left, work.leaves), (0, 0, 0));
    assert_eq!(work.refusals.len(), 1);
    assert!(work.refusals[0].contains("work budget"));
}
