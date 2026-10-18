<!-- SPDX-License-Identifier: MPL-2.0 -->
# Material-layer program

`geometry/program/layers` now owns the layer child used by the existing public
`GeometryRouter::process_element_with_material_layers` entrypoint and both
canonical layered submesh gateways. The router retains gateway diagnostics and
mesh hygiene. The former source, plane and slicing implementations are removed
from the router rather than retained as a second route.

Admission preserves the existing buildup and layer-count checks, first Body
representation policy, single-item identity-position walk and thin-layer merge.
The walk remains iterative with a visited set; it does not introduce a depth cap.
The program then requests the actual merged host with openings. Only a nonempty
host reaches the original placement service. Plane construction takes that
resolved placement, unit scale, RTC offset and the actual host origin as owned
inputs. The ready slice contains the host, visual layers and interface planes;
its numerical evaluator has no decoder, router or source callback.

The original uncapped progressive carving, material identifiers, dominant-material
merge rules, split-failure recovery and diagnostic strings remain in use. Public
borrowed callers do not copy source bytes, entity inputs or model maps. No
resource/diagnostic guard is stored across a child transition. Opening production
inside the host request still uses its existing owner; this extraction does not
claim complete opening control or complete product execution.

Existing thin-layer and long/cyclic identity-walk tests move with their code.
Additional public-path tests use a real parsed wall to check material order,
partitioned outer-shell area and absence of interior cap sheets, including a
rotated millimetre model with survey-coordinate placement and matching RTC.
These synthetic invariants do not replace real-model or browser qualification.

Validation and performance are pending for this source layer. Earlier program
and context receipts retain their own source scope; no speed or non-regression
verdict, resource envelope or production cutover is claimed here.
