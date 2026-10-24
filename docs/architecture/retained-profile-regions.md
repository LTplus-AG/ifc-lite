# Retained profile regions

The retained construction path uses `capture_retained_extrusion` for both native
and browser execution. Simple profiles keep the existing extrusion recipe.
A non-simple authored profile can instead produce a distinct
`RetainedRecipe::RegularizedExtrusion`. This does not change analytic export or
the default exact engine's conservative simple-region contract.

The initial supported family is one `IfcArbitraryClosedProfileDef` with an
explicit line-only `IfcIndexedPolyCurve` or `IfcPolyline`, at most 128 edges,
and one isolated axis-aligned retraced spur. The proof requires exact finite
XY endpoint equality and strict coordinate ordering. It does not infer
collinearity from a tolerance, snap coordinates, or simplify arbitrary vertices.
Other curve families, ambiguous configurations and unresolved regions refuse.

The fill policy is **nonzero winding**, ignoring the zero-area retraced spur.
Two opposite directed traversals of the same interval have equal and opposite
winding contributions at every point off that interval. Their cancellation
therefore preserves the material region. A coordinate plane through the
attachment must strictly separate every other authored vertex from the spur.
Convexity of each line then proves the cancelled interval has no other
intersections. The surviving loop must pass the unchanged analytic Jordan-region
validator, including clearance against the original context Precision.

The sealed `RetainedProfileRegion` retains the original solid, profile and
boundary source records, every original segment, raw Precision range, the
cancelled interval and its two original edge ordinals. Each surviving edge
carries its original ordinal and directed subinterval endpoints in raw units.
The original walk remains marked unsupported as a simple analytic profile.
Only an internal temporary encoding view substitutes the proved boundary;
the immutable request retains the distinct recipe and certificate. Original
unit scale, source epoch/revision, placements, request admission, worker identity
and completion-frame checks remain in the shared transaction. Boundary ordinals
are not persistent SDK face IDs or UV provenance.

The proof uses no recursive geometric traversal: input is bounded before its
retained parser, its scan has a 16,384-work budget, and the existing topology
validator has a separate 1,000,000-work / 48-refinement-depth bound. Audited
scratch/proof allocations and source-record copies are charged to the current
source account; geometric work reserves its conservative worst-case bound.
Source metadata copy walks separately cap depth at 32 and values at 1,000,000.
Reservations follow existing conservative transaction retention. These bounds
are not claims about allocator rounding, opaque SDK memory or process RSS.

For the unchanged committed #3641 fixture, solid 61271 references profile 61272,
curve 61273 and point list 61274. Edges 4 and 0 retrace exactly 870 mm from
(0,0) to (870,0). Raw Precision is 0.2 mm. The slope ending at
(4500,-900.00001) is preserved. Decimal rational shoelace area is
6057000031/2000 mm²; depth is 25632 mm; volume is 77.626512397296 m³.
The authored direction (1e-9,3e-10,-1) is preserved, including its lateral drift.

Preregistered test tolerances are 1e-8 mm² for decoded fixture area, 1e-12 m²
for unit controls, 1e-6 m³ for SDK/triangle volume, 1e-7 m for the mid-depth
section, and 1e-6 m for survey-frame reconstruction. Volume-query precision
is 1e-8; tessellation chord is 0.001 m and angle is 5 degrees. Existing topology
clearance uses max(raw Precision,1e-9 raw units), while joins use
min(raw Precision,1e-9 raw units). No tolerance is widened by regularization.

Source tests, real native/browser construction test definitions and four
independent reverse mutations are committed. Execution remains a validation
gate: source admission alone does not close #3641. J2 must execute the original
host's ordered three cuts and verify final geometry. J5 must establish persistent
face identity and UVs. Final-product publication and viewer/CLI activation are
not enabled by this prerequisite.
