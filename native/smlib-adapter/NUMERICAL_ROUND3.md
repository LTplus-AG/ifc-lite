<!-- SPDX-License-Identifier: MPL-2.0 -->
# Native numerical contract, round 3
Base ccea8d2365; SDK c9c5979f04cea8c38213004d4f04df0dcfb40d05 (Apache-2.0).
Implementation only native/smlib-adapter; source interpretation remains caller-owned. UNQUALIFIED until actual targets execute.

Opcode17: session u64 + WireHandle (u64 session,u32 slot,u32 generation) +16 LE f64 column-major, response new WireHandle. Affine last row exactly [0,0,0,1], finite coefficients <=1e9, orthonormal basis within1e-12, positive determinant within1e-12 of1. SDK SmApiBrepCopy(input,SmBrep*&), then SmApiTransform(copy,SmAxis2Placement). Frame SetCanonical(origin,column0,column1); column2 must equal cross(column0,column1). Original remains immutable on success/failure. Capability bit3.

SweepBegin opcode13 unchanged fields. Format1 fixed records unchanged. Add format2 swept disk: declaration loops=1,segments=1; length variable <=1MiB. Recipe u32[format=2,loops=1,segments=1,reserved=0], f64 radius, f64 inner_radius=0, followed by one rational path kind4 record. Capped open path only; hollow/closed/self-intersecting paths, joins/fillets and arbitrary source trim conventions unsupported. Positive radius. Capability bit1 denotes format2 implemented, NOT qualified.

Kind4 record: u32 kind=4,reserved=0,degree,control_count,knot_count,flags=0; f64 trim_start,trim_end; control_count*(f64 x,y,z,weight); knot_count*(f64 unique_knot,u32 multiplicity,u32 reserved=0). Degree1..32; controls2..8192; knots2..8192; positive finite weights; strictly increasing knots, clamped ends degree+1, interior mult<=degree, sum mult=control_count+degree+1. Trim contained in clamped knot domain and increasing. Calls SmBSplineCurve::CreateCanonical(context,3,degree,EuclideanControls,SM_CF_UNSPECIFIED,multiplicities,knots,SM_KT_UNSPECIFIED,&weights,&trim,result), NO sample fitting. Numerical trimmed coefficients do not replace caller's original authored coefficients.

Rational region records are NOT added to format1: its fixed-size declaration must remain stable. General rational planar regions require an additive format3 and independently defined area/winding validation; presently explicit unsupported. Format2 rational path is the available consumed coefficient route. Runtime Rust additions proposed here only, not edited by native owner.
