// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7887: private fallible extraction preserves a typed terminal and completed
//! drawing output; cancellation is never reported as malformed model content.
use super::*;
use crate::resource::{ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
#[path = "../../tests/support/profile_walk_model.rs"]
mod model;

#[test]
fn issue_7887_drawing_terminal_is_not_relabelled_as_a_content_drop() {
    let source = model::chain(1);
    let mut decoder = EntityDecoder::new(&source);
    let router = GeometryRouter::with_units(&source, &mut decoder);
    let entity = decoder.decode_by_id(100).unwrap();
    let processor = ProfileProcessor::new(IfcSchema::new());
    let walk = RepresentationWalk {
        select: Select::Meshed,
        nested: NestedMaps::Expand { max_depth: MAX_MAPPED_ITEM_DEPTH, max_levels: MAX_WALK_LEVELS },
    };
    let (mut profiles, mut skipped) = (Vec::new(), Vec::new());
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    account.scope(|| {
        extract_product(&router, &processor, &walk, &entity, "IfcWall", 7, 2,
            &mut decoder, &mut profiles, &mut skipped).unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].extrusion_depth, 1.);
        account.cancel();
        // Zero allowance would otherwise produce a logical/content refusal.
        let result = extract_product(&router, &processor, &walk, &entity, "IfcWall", 7, 0,
            &mut decoder, &mut profiles, &mut skipped);
        assert!(matches!(&result, Err(crate::Error::ProgramStopped(ProgramStop::Cancelled))));
        assert_eq!(profiles.len(), 1, "completed profiles survive the terminal");
        assert!(skipped.is_empty(), "private failure is not a generic malformed-profile skip");
        record_execution_stop(result.unwrap_err(), &entity, "IfcWall", &mut skipped);
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].express_id, 100);
        assert_eq!(skipped[0].reason, "execution-stop: execution cancelled");
        assert_eq!(crate::resource::check_current(), Err(ProgramStop::Cancelled));
        // No product is known when the public scan sees an existing stop. It
        // stops entirely and must not manufacture a skipped product ID.
        let (next, drops) = extract_profiles_with_diagnostics(&source, 7);
        assert!(next.is_empty());
        assert!(drops.is_empty());
    });
}
