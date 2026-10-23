// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Ordered composition of the diff passes. Additive claims never retire keys.
use crate::model::{EntityFingerprint, KeyDiff, KeyDiffOptions};
use crate::key_diff::diff_by_key;
use crate::content_match::apply_content_matching;
use crate::content_types::ContentMatch;
use crate::geometry_compare::GeometryTolerances;
use crate::split_merge::detect_split_merge;
use crate::split_types::{SplitMergeClaim, SplitSettings};
use crate::successor::{detect_successors, SuccessorClaim, SuccessorSettings};

#[derive(Debug, Default)]
pub struct DiffOptions {
    pub key: KeyDiffOptions,
    pub geometry: GeometryTolerances,
    pub match_unpaired_by_content: bool,
    pub detect_split_merge: bool,
    pub detect_successors: bool,
    pub split: SplitSettings,
    pub successor: SuccessorSettings,
    pub class_families: Option<Vec<Vec<String>>>,
}
#[derive(Debug)]
pub struct ModelDiff<'a, R> {
    pub core: KeyDiff<'a, R>,
    pub content_matches: Option<Vec<ContentMatch<'a, R>>>,
    pub split_merges: Option<Vec<SplitMergeClaim<'a, R>>>,
    pub successors: Option<Vec<SuccessorClaim<'a, R>>>,
}
pub fn diff_models<'a, R>(base: &'a [EntityFingerprint<R>], head: &'a [EntityFingerprint<R>], options: &DiffOptions) -> ModelDiff<'a, R> {
    let core = diff_by_key(base,head,&options.key);
    let (core,content_matches) = if options.match_unpaired_by_content {
        let matched = apply_content_matching(core,options.geometry);
        (matched.core,Some(matched.content_matches))
    } else { (core,None) };
    let families = options.class_families.as_deref();
    let split_merges = if options.match_unpaired_by_content && options.detect_split_merge {
        detect_split_merge(&core.entries,core.use_geometry,options.split,families)
    } else { None };
    let successors = if options.match_unpaired_by_content && options.detect_successors {
        let bound: Vec<_> = split_merges.iter().flatten().flat_map(|c|std::iter::once(c.whole).chain(c.pieces.iter().copied())).collect();
        detect_successors(&core.entries,core.use_geometry,&bound,options.successor,options.geometry,families)
    } else { None };
    ModelDiff { core,content_matches,split_merges,successors }
}
