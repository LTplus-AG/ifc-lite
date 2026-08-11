---
'@ifc-lite/clash': minor
---

Decide "exact duplicate" from the geometry, and stop hiding duplicated GlobalIds.

**Triangle count was a two-way-wrong signature.** `findDuplicates` promoted a
near-coincident pair to `major` ("exact duplicate") only when the two elements
had the same number of triangles. That is a proxy for "same mesh", and it fails
in both directions: a genuine duplicate re-tessellated on re-import (12 vs 48
triangles, geometrically the identical box) was demoted to `minor`, while a
round column and a square column that happen to share a bounding box and a
triangle count were promoted to `major`. Users filtering to `major` therefore
lost real duplicates and gained fake ones.

Severity is now decided by a tessellation-invariant signature of the element's
world-space triangle soup: total surface area and enclosed (divergence-theorem)
volume. Both are integrals over the surface, so re-triangulating one copy leaves
them unchanged — a 12- and a 48-triangle 1×1×3 box both give area 14 and volume
3 — while a round and a square column of the same bounds differ by 22.7% in area
and 25.0% in volume. The two must agree to within 5%, which is wide enough to
hold together a 12- and a 36-segment column (4.0% apart in volume, the same
authored solid at two facet densities) and ~5× tighter than the gap between
genuinely different shapes. The tolerance is relative, so it means the same
thing on a 50 mm fixing and a 30 m tank.

The signature is per **element**, summed over the several meshes a
multi-material / CSG element emits. Those parts' cross pairs all collapse to
one clash id, so a per-mesh comparison would have let whichever part pairing
the sweep reached first decide the label — a two-material wall and its exact
copy could read `minor` because part 1 was first compared against part 2. The
deduped finding is also upgraded to `major` when any later part pairing shows
the copies coincide, so the label no longer depends on sweep order at all.

`major` now means: some pair of the elements' boxes coincides within
`exactTolerance` **and** the two elements' meshes agree on area and volume. It still cannot distinguish two different
solids that happen to agree on both numbers, nor an element from its mirror
image, and an element whose geometry the caller did not supply is never promoted
at all. Matching — which pairs are reported — is unchanged and still
bounding-box-only, so a duct inside a shaft that shares its bounds is still
reported (as `minor`); separating nested from coincident needs a narrow phase
this pass deliberately does not run.

**Duplicated GlobalIds were invisible.** The self-pair guard skipped any pair
sharing a key and a model. But a file can carry one GlobalId on two genuinely
different entities — a defect `ifc-lite validate` reports — and that is exactly
the "same element exported twice" case a duplicate hunt exists to find. Identity
is now `(model, ref)`: `key` is the GlobalId, which a broken exporter can
repeat, while `ref` is the express id, unique by construction. The several
meshes one element emits (one per material or CSG part) share both key and ref,
so they are still skipped. `groupDuplicateSets` counts nodes the same way, so
such a pair now reads "2 coincident objects" rather than "1".

Clash ids are unchanged for well-formed files: the express id is folded into an
id only for a key that two different elements actually carry, which is also what
stops three copies under one GlobalId collapsing into a single deduped finding.

Cost is unchanged. The signature is O(triangles), computed at most once per
element and only for pairs that already coincide, so a model with no duplicates
never reads a vertex. Across five public models the reported pairs, their ids,
their severities and their groupings are all identical to the distance-tolerance
baseline this builds on (1 / 0 / 0 / 0 / 32, split 22 `major` / 10 `minor` —
"before" here means after that change, which itself moved eight pairs from
`major` to `minor`; see its changeset); computing every element's signature eagerly,
which the pass does not do, would cost 2.6 ms over the 236,795 triangles of the
largest of them against a 215 ms pass (the measurement the `findDuplicates`
docs cite).
