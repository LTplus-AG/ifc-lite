// SPDX-License-Identifier: MPL-2.0
//! Polls expose each reached whole-list source boundary without walking it.
use super::*;
use std::sync::Arc;

const SOURCE: &str = "#1=IFCWALL('w',$,$,$,$,$,#2,$);
#2=IFCPRODUCTDEFINITIONSHAPE($,$,(#3,#4));
#3=IFCSHAPEREPRESENTATION($,'Body','CSG',(#10,#10));
#4=IFCSHAPEREPRESENTATION($,'Body','CSG',(#999));
#10=IFCBLOCK($,2.,3.,4.);";

#[test]
fn traversal_poll_preserves_later_source_mutation_and_repeated_occurrences() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let element = decoder.decode_by_id(1).unwrap();
    let mut program = ProductProgram::admit(&element, EntryPolicy::MergedProduct, &mut decoder)
        .unwrap().unwrap();
    let TraversalPoll::Items(request) = program.poll() else { panic!("first Items request") };
    assert!(matches!(program.poll(), TraversalPoll::Pending));
    program.accept_items(request.admit(&mut decoder)).unwrap();
    let TraversalPoll::Item(first) = program.poll() else { panic!("first occurrence") };
    let TraversalPoll::Item(second) = program.poll() else { panic!("second occurrence") };
    assert_eq!((first.item.id, second.item.id), (10, 10));
    // The next representation's complete Items admission has not happened;
    // earlier item callbacks may therefore repair its previously missing ref.
    decoder.inject_shared_cache(&[(999, Arc::new(first.item))].into_iter().collect());
    let TraversalPoll::Items(request) = program.poll() else { panic!("later Items request") };
    program.accept_items(request.admit(&mut decoder)).unwrap();
    assert!(matches!(program.poll(), TraversalPoll::Item(_)));
    assert!(matches!(program.poll(), TraversalPoll::Complete));
}

#[test]
fn traversal_whole_items_fault_prevents_repair_by_earlier_sibling() {
    let source = SOURCE.replace("(#10,#10)", "(#10,#998)");
    let mut decoder = EntityDecoder::new(&source);
    let element = decoder.decode_by_id(1).unwrap();
    let mut program = ProductProgram::admit(&element, EntryPolicy::StyledProduct, &mut decoder)
        .unwrap().unwrap();
    let TraversalPoll::Items(request) = program.poll() else { panic!("Items request") };
    assert!(program.accept_items(request.admit(&mut decoder)).is_err());
    assert!(matches!(program.poll(), TraversalPoll::Complete),
        "an admitted whole-list fault cannot expose its first valid sibling");
}

#[test]
fn opening_probe_skips_faulted_items_list_at_same_poll_boundary() {
    let source = SOURCE.replace("(#10,#10)", "(#998)").replace("(#999)", "(#10)");
    let mut decoder = EntityDecoder::new(&source);
    let element = decoder.decode_by_id(1).unwrap();
    let mut program = ProductProgram::opening(&element, EntryPolicy::OpeningItemMeshes, &mut decoder)
        .unwrap().unwrap();
    let TraversalPoll::Items(request) = program.poll() else { panic!("first Items") };
    program.accept_items(request.admit(&mut decoder)).unwrap();
    let TraversalPoll::Items(request) = program.poll() else { panic!("second Items") };
    program.accept_items(request.admit(&mut decoder)).unwrap();
    let TraversalPoll::Item(item) = program.poll() else { panic!("valid later item") };
    assert_eq!(item.item.id, 10);
    assert!(!item.fill_only);
    assert!(matches!(program.poll(), TraversalPoll::Complete));
}
