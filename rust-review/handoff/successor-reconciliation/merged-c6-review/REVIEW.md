# C6 merged-source support disposition

**Both prior findings remain in exact merged main `aca9452d04cd095ffc58141b4ad487655e77f133`.** This is a new source-disposition check after the PR heads changed; it is not a duplicate implementation or a new defect hunt. Neither a merge, a generic approval, a clean bot result nor #7783's automatic closure resolves the cited behavior.

## Pins and source identity

| Context | Original reviewed head | Final PR head | Merge |
|---|---|---|---|
| #7868 | `ee7bdf4e38ade6c3ecb3348fe4eaeabc4d571b00` | `83fa1771ee37d7ee7f63f38c1e213b75eaa0d4a9` | `c7b0e7be30bd247da84a1f8cb019cb51cfc6e638` |
| #7875 | `a7387c898f548e7ac19c0719b6da52d9f626e39e` | `01ef155696960c65d632e4ab39f0bd078422e26c` | `aca9452d04cd095ffc58141b4ad487655e77f133` |

The **entire TypeAssignments production file and its two-test file are byte-identical** from the original #7868 reviewed head to the final head, #7868 merge and captured main. IFCX's **entire `export_ifc5` implementation, through the end of its file, is byte-identical** between original #7875 head and final head/main; the full final-head IFCX file equals merged main. `spatial_walk_formats.rs` is byte-identical from the original #7875 head through final head/main. Unrelated earlier portions of IFCX gained typed slot reads; those do not alter this finding's call path. Exact SHA256 comparisons are preserved in `pins.json`.

The final PR head objects were initially absent locally. The only fetch was `git fetch --no-tags --no-write-fetch-head origin <83fa…> <01ef…>` for those exact objects. No branch/FETCH_HEAD/index/checkout was updated. Root checkout remained `588ad5b1788a914b114f239319f79a0fd7b337d9` at the recorded post-capture check. Source was read with `git show` and pins with `git rev-parse`; all written files are outside the repo.

## #7868: quadratic conflict membership — remains unresolved

Original context: [support comment6240195566](https://github.com/LTplus-AG/ifc-lite/pull/7868#issuecomment-6240195566).

At [merged `type_assignments.rs:52–60`](https://github.com/LTplus-AG/ifc-lite/blob/aca9452d04cd095ffc58141b4ad487655e77f133/rust/processing/src/data_model/type_assignments.rs#L52), an object already in conflict checks every later distinct target with `types.contains(&type_id)` before appending. There is still no hashed membership or equivalent linear bound. For one object with N distinct targets, the comparison work grows quadratically. A later repeat of an existing target can also scan the full accumulated vector. This is the same production file as the original reviewed head, not merely the same text pattern somewhere else.

The original dangling-target amplification remains reachable in the actual merged callers:

- [quantity_analysis_relations.rs:61](https://github.com/LTplus-AG/ifc-lite/blob/aca9452d04cd095ffc58141b4ad487655e77f133/rust/export/src/quantity_analysis_relations.rs#L61) accepts the reference ID, and [lines86–96](https://github.com/LTplus-AG/ifc-lite/blob/aca9452d04cd095ffc58141b4ad487655e77f133/rust/export/src/quantity_analysis_relations.rs#L86) charges one relationship link before calling `assignments.record`. The product must be in the selected product map, but the type target need not decode or exist before admission. The100,000-link default (`quantity_analysis.rs:31`) bounds links, not the membership comparisons performed inside that call.
- [rebar_schedule_build.rs:65–83](https://github.com/LTplus-AG/ifc-lite/blob/aca9452d04cd095ffc58141b4ad487655e77f133/rust/export/src/rebar_schedule_build.rs#L65) records syntactically valid target references before checking target existence/class. It starts with 100,000 references (`rebar_schedule.rs:118`), then validates candidates only [at lines124–127](https://github.com/LTplus-AG/ifc-lite/blob/aca9452d04cd095ffc58141b4ad487655e77f133/rust/export/src/rebar_schedule_build.rs#L124). Thus many missing type IDs still accumulate the costly vector before the first-valid policy is applied.

Test evidence inspected, not executed: `type_assignments_tests.rs` still has only `first_wins_and_the_conflict_is_recorded` and `conflicts_come_in_the_order_they_were_first_seen`. They cover ordered candidates, first-wins, repeated small targets and unambiguous policy. They do not exercise the many-distinct/repeated-target work invariant requested by the support finding, and have not changed since that finding.

**Disposition:** unresolved in merged source; retain the original support context and canonical continuation obligation. Existing C6 owner should specifically answer or correct membership admission with a linear mechanism while preserving ordered vectors, first-wins, conflict policy and rebar first-valid. No new patch, benchmark or end-to-end performance measurement was performed here.

## #7875: IFCX discards canonical first-parent ownership — remains unresolved

Existing contexts: [inline4303597235](https://github.com/LTplus-AG/ifc-lite/pull/7875#discussion_r4303597235) and [current-original-head repeat4304447045](https://github.com/LTplus-AG/ifc-lite/pull/7875#discussion_r4304447045). This report keeps those existing reviewer contexts rather than inventing a separate finding.

The canonical walk's merged module documents first-parent ownership and returns `SpatialVisit.parent`. [IFCX lines183–185](https://github.com/LTplus-AG/ifc-lite/blob/aca9452d04cd095ffc58141b4ad487655e77f133/rust/export/src/ifc5.rs#L183) still retain only each visit's ID. Output reconstruction at [lines203–210](https://github.com/LTplus-AG/ifc-lite/blob/aca9452d04cd095ffc58141b4ad487655e77f133/rust/export/src/ifc5.rs#L203) traverses every original child edge, admitting it whenever the child is globally seen; it never checks which parent won.

The actual committed `rust/export/tests/spatial_walk_formats.rs::FILE` already supplies a complete counterexample: project #1 → site #2 → buildings #3/#4; wall #5 belongs to both buildings; wall #6 only to #4. The canonical walk visits1,2,3,5,4,6 and selects building #3 as wall #5's parent. The current IFCX emitter nevertheless builds a `WallShared_5` child entry under **both** building #3 and building #4 because wall #5 is in the global seen set. This is a direct trace through the actual existing fixture and actual merged emitter, not an invented mock output or executed runtime assertion.

Test evidence inspected, not executed:

- `spatial_walk_tests.rs::the_first_parent_owns_a_shared_child` asserts the helper visit's parent correctly. That proves the intended helper invariant in source-level test design; the emitter does not consume it.
- `spatial_walk_formats.rs::csv_lists_source_order_and_the_first_parent_owns_the_shared_wall` asserts CSV's parent and level.
- `spatial_walk_formats.rs::ifcx_lists_the_same_order` asserts IFCX path count/order only. It never inspects either building's `children`, so the already supplied shared-child fixture does not test the disputed consumer behavior. The file is unchanged at all compared pins.

**Disposition:** unresolved in merged source. Existing owner must preserve the selected parent in IFCX reconstruction or provide a specific supported policy disposition. The finite regression is already available: inspect the actual exported building children and require wall #5 only under building #3 while retaining wall #6 under #4, plus the existing node order/count. No runtime export was run by this pass.

## Owner/review qualification and completeness limits

The provided `c6-type-assignments-live.json` / `c6-spatial-live.json` establish final head/merge/state pins and preserve the coordinator's general approvals. The combined approval says first-wins policies are equivalent and IFCX corpus nodes are a pure reorder. Those claims do not address target-controlled membership work or shared-child ownership. The #7868 metadata also includes a clean automated review for final head83fa at 22:03; that is not a specific rebuttal or a source change. No specific semantic resolution of either finding is present in these provided snapshots. This pass did not fetch fresh comments or threads or reinterpret their UI state.

Parent reports #7783 auto-closed on #7875 at 22:00:44 UTC, while approved D47 #7895 remains open at 3c4… with its separately reported shared-Pset-budget finding. **No C6/charter completeness claim follows.** D47 source/behavior was deliberately not re-reviewed; its active owner retains the lane.

This pass proves current source persistence and test-coverage limitations at exact pins. It does not claim a newly executed exploit, runtime/export qualification, full PR approval, benchmark result or gate outcome. No test/build/browser/lock/job/GitHub post occurred. [pins.json](pins.json) and [source-manifest.json](source-manifest.json) preserve all source hashes/comparisons and the allowed exact-object fetch; source snapshots are under `sources/` and provided metadata is copied alongside.

This public companion includes the review, dispositions, pins and source manifest. Local source copies and provided metadata captures mentioned above are not included; the cited immutable GitHub source links and public PR comments support the trace.
