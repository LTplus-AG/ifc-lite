# Affine concrete source-class diagnosis

Scope: immutable adapter source 1fb69c5fe0b433452fe7c0bf353bff3b8b650a26 and SDK c9c5979f04cea8c38213004d4f04df0dcfb40d05. The adjacent hashes JSON pins twelve primary SDK files and five immutable adapter Git blobs. Current parent affine_tests.cpp has later diagnostics, so failed assertions are assessed from the pinned Git blob. No repository/SDK edits, builds, jobs or executable probes by this reviewer.

## Concrete cause

The geometrically cylindrical BRep is represented by a zero-angle SmCone. The test incorrectly requires concrete SmCylinder class slot8.

Adapter adapter.cpp invokes the SmBrep*& overload of SmApiCreateCylinder. SDK SmApiPrimitives.cpp383–393 delegates directly to SmApiCreateCone(origin,radius,radius,height,result). The distinct SmSurface*& overload401–453 allocates SmCylinder; it is not invoked here. SmApiCreateCone calls SmPrimitiveCreation::CreateCone(height,base,top,0,360,frame). SmPrimitiveCreation.cpp35 defines USE_NEW_ANALYTICS; the full360 branch764–767 calls analytic CreateCone647–720. That calls SmCone::CreateCanonical, which explicitly allocates new SmCone (SmCone.cpp375–436). Equal radii merely leave m_dSemiAngleDeg zero in its bounded constructor149–218. SmCone.h594 plus SmTypes.h370–377 make actual GetType return SmCone_TYPE. Rational coefficient materialization does not change the concrete C++ class.

The two caps are built via CreatePlanarFaceWith3DCurves and stitched. affine.cpp classifies actual GetType, mapping Cone to9 and Cylinder to8. It counts BEFORE copy; verifies copied source counts unchanged BEFORE TurnToNURBS; publishes the original prepared counts. Thus the certificate is not reclassifying transformed geometry as Cone.

## Strong independent expected arrays

Class order: curve BSpline/Line/Circle/Ellipse/Parabola/Hyperbola, surface BSpline/Plane/Cylinder/Cone/Sphere/Torus.

Box: [0,12,0,0,0,0,0,6,0,0,0,0]. SmPrimitiveCreation::CreateBox270–390 explicitly creates six SmPlane faces with rectangular domains. SmPlane::CreateIsoParametricCurve836–905 explicitly creates SmLine segments. The closed rectangular box has12 unique edges, not24 face-edge uses.

Equal-radius Cone BRep: [0,1,2,0,0,0,0,2,0,1,0,0]. SmCone::CreateIsoParametricCurve1229–1608 explicitly creates SmCircle for constant V (the two circular rims) and SmLine for constant U (the periodic seam). The two planar caps share the two rims after stitching; they do not introduce additional unique rims. The side is one SmCone with zero semi-angle, and there are two planar caps. SmBrep::GetCurves10981–11016 enumerates edge-owned curves and GetSurfaces10923–10974 face-owned surfaces, matching certificate unique-geometry semantics. The exact stitched seam ownership is additionally witnessed by the parent diagnostic below; this is a pinned-constructor expectation, not a universal geometric-cylinder class claim.

## Actual diagnostic supplied by parent

Parent's tiny existing-binary probe used source1fb worker SHA256 3e38eda1e773dc97d3503da56d9714f6ede891732239f1f079a71968c0a6e2ef. Remote PC receipt: /tmp/ifclite-1fb-affine-class-diagnostic.json. Parent reports both calls status0/certv1/rep1, box counters exactly [0,12,0,0,0,0,0,6,0,0,0,0], cylinder counters exactly [0,1,2,0,0,0,0,2,0,1,0,0]. This disambiguates the failed combined assertion: box passes; the following equal-radius Cone fails slot8. This reviewer has not independently fetched/hashed that remote receipt; parent owns its raw provenance and archive.

## Recommended correction and qualification boundary

Use the exact all12 arrays above, with a comment explaining the pinned BRep cylinder factory's equal-radius Cone representation. This is stronger than the old partial slot checks. Do not use Cylinder-or-Cone, sums, wider tolerance, or geometry-derived reclassification. Preserve every downstream independent volume, inverse-transform boundary, elliptic section, source immutability, signed determinant, triangle normal, reflected winding, opposed edge incidence and failed-copy oracle.

If explicit concrete SmCylinder conversion coverage is desired, it needs a separate real fixture built through the actual SmSurface*& Cylinder overload and attached to a BRep. The current fixture is positive Cone conversion, not SmCylinder coverage. No SDK/C ABI correction is indicated by this failure. Full normal SDK qualification must rerun: the failed full test did not reach subsequent numerical affine/plane checks, and the tiny status0/class probe is not their substitute. No passing overall runtime or numerical-preservation claim.
