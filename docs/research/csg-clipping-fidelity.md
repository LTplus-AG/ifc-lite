# IFC CSG Clipping Fidelity — Research Notes

**Branch:** `refactor/csg-fidelity-vs-ifcopenshell` · **Context:** Issue #583 (AC20-Institute-Var-2 wall slivers)

Synthesizes the IFC 4.3 spec definitions and the two reference implementations (ifcopenshell, web-ifc) for `IfcPolygonalBoundedHalfSpace` / `IfcBooleanClippingResult`, then identifies the gap in our implementation.

---

## 1. IFC 4.3 Spec — what the entities actually mean

### `IfcHalfSpaceSolid`
- `BaseSurface`: an unbounded `IfcElementarySurface` (almost always `IfcPlane`).
- `AgreementFlag`:
  - `TRUE` → material is on the side the normal points **AWAY FROM** (i.e. on the **−normal** side).
  - `FALSE` → material is on the side the normal points **INTO** (the **+normal** side).
- The half-space itself is unbounded. The `BaseSurface`'s `Position` defines the plane's coordinate frame.

### `IfcPolygonalBoundedHalfSpace` (subtype of `IfcHalfSpaceSolid`)
- Adds two attributes: a `Position` (its OWN `IfcAxis2Placement3D`) and a `PolygonalBoundary` (a closed 2D curve).
- The polygon is in **the XY plane of this entity's own Position** — *not* the plane's Position.
- The polygon "is extruded perpendicular to the XY plane of the position coordinate system, that is, into the direction of the positive Z axis defined by the Position attribute".
- Geometric meaning: *"the theoretical intersection between the half space solid and an extruded area solid, defined by extruding the polygonal boundary"*.
- **Two independent coordinate frames** — easy to confuse. The plane lives in the BaseSurface's frame; the polygon lives in the cutter's Position frame.

### `IfcBooleanResult` / `IfcBooleanClippingResult`
- `ClippingResult` is a constrained subtype: `Operator` must be `DIFFERENCE`, `SecondOperand` must be (a subtype of) `IfcHalfSpaceSolid`. `FirstOperand` may be `IfcSweptAreaSolid`, `IfcSweptDiskSolid`, or another `IfcBooleanClippingResult` — that's the only chaining mechanism.
- `Result = FirstOperand − SecondOperand` (operand order matters for `DIFFERENCE`).
- No spec text about boundary inclusion or epsilon handling — that's an implementation concern.

---

## 2. ifcopenshell — topological, OCCT/CGAL kernel

Source: `src/ifcgeom/mapping/IfcPolygonalBoundedHalfSpace.cpp`, `IfcHalfSpaceSolid.cpp`, `IfcBooleanResult.cpp`, kernel adapters under `src/ifcgeom/kernels/`.

### Mapping (the entity → taxonomy step)
```cpp
// IfcHalfSpaceSolid.cpp
auto p = taxonomy::make<taxonomy::plane>();
p->matrix = taxonomy::cast<matrix4>(map(plane->Position()));
auto f = taxonomy::make<taxonomy::face>();
f->orientation.reset(!inst->AgreementFlag());  // flips orientation when AgreementFlag=FALSE
f->basis = p;
// wrap in shell → solid
```

```cpp
// IfcPolygonalBoundedHalfSpace.cpp
auto s = map_impl((IfcHalfSpaceSolid*) inst);  // start from the half-space
auto f = s->children[0]->children[0];          // dive to the face
f->children = { map(inst->PolygonalBoundary()) };  // attach polygon as the face's loop
f->matrix = map(inst->Position());             // cutter Position applied to the face
return s;
```

**Key insight**: ifcopenshell doesn't build a mesh at all in the mapping stage. It builds a *topological* description: an oriented face with a planar basis surface and a polygonal loop. The actual geometric realisation happens in the kernel (OCCT or CGAL).

### Kernel — CGAL path (`CgalKernel.cpp`)
For a plain `IfcHalfSpaceSolid` operand, CGAL builds a **bounding box** sized to the HOST plus an epsilon margin:

```cpp
static double inf = 1.e9;
static double eps = 1.e-5;
// ... project host onto plane's UV plane, get UV bounds ...
double wmin, wmax;
if (face->orientation.get_value_or(false)) {
    wmin = 0.;  wmax = uvw_max[2] + eps;
} else {
    wmin = uvw_min[2] - eps;  wmax = 0.;
}
Kernel_::Point_3 lower(uvw_min[0] - eps, uvw_min[1] - eps, wmin);
Kernel_::Point_3 upper(uvw_max[0] + eps, uvw_max[1] + eps, wmax);
cgal_shape_t box = utils::create_cube(lower, upper);
```

Key points:
- The cutter is sized to the **host** (it sees the other operand before deciding extents).
- **`eps = 1e-5`** padding in ALL directions ensures boundary inclusion at the host's edges.
- For `PolygonalBoundedHalfSpace`, the polygon loop replaces the box's UV face — CGAL clips the box to the polygon's prism.

### Boolean chain handling (`IfcBooleanResult.cpp`)
```cpp
// Flatten chains of same-operator boolean results into a single batched operation
while (res1 && boolean_op_type(res1->Operator()) == op) {
    operand1 = res1->FirstOperand();
    operands.push_back(res1->SecondOperand());
    res1 = operand1->as<IfcBooleanResult>();
}

// EXCEPT: if more than 8 half-space operands accumulate, fall back to sequential
if (res1 && res1->SecondOperand()->as<IfcHalfSpaceSolid>() && ++n_half_space_operands > 8) {
    process_as_list = false;  // sequential, one boolean_result node per IFC entity
}
```

So ifcopenshell **does** batch chained operands — but only up to 8 half-spaces, because OCCT struggles with too many simultaneous half-space operands (edge-edge interference checks blow up).

---

## 3. web-ifc — mesh-CSG, closer to us

Source: `src/cpp/web-ifc/geometry/IfcGeometryProcessor.cpp` (the `IFCPOLYGONALBOUNDEDHALFSPACE` and `IFCBOOLEANCLIPPINGRESULT` cases).

### PolygonalBoundedHalfSpace → mesh
```cpp
// Get attributes
IfcSurface surface = GetSurface(surfaceID);
glm::dmat4 position  = GetLocalPlacement(positionID);  // the cutter's Position
IfcCurve curve       = GetCurve(boundaryID, 2);        // polygon in cutter-local XY

if (!curve.IsCCW()) curve.Invert();                    // explicit CCW normalisation

// Transform the PLANE into the cutter's local frame
glm::dmat4 invPosition       = glm::inverse(position);
glm::dvec3 localPlaneNormal  = invPosition * glm::dvec4(planeNormal,   0);
glm::dvec3 localPlanePos     = invPosition * glm::dvec4(planePosition, 1);

// Extrude polygon along cutter-local +Z by a FIXED LARGE DISTANCE (e.g. 50 m).
// The plane (now in cutter-local) is passed to Extrude() as the LOWER CAP plane.
glm::dvec3 extrusionNormal = glm::dvec3(0, 0, 1);
double extrudeDistance     = EXTRUSION_DISTANCE_HALFSPACE_M / linearScaling;

// Flip extrusion sign based on plane orientation × cutter Z × agreement flag
bool halfSpaceInPlaneDirection = (agreement != "T");
bool extrudeInPlaneDirection   = glm::dot(localPlaneNormal, extrusionNormal) > 0;
bool ignoreDistanceInExtrude   = (!halfSpaceInPlaneDirection &&  extrudeInPlaneDirection)
                               || ( halfSpaceInPlaneDirection && !extrudeInPlaneDirection);
if (ignoreDistanceInExtrude) {
    extrudeDistance *= -1;
    flipWinding = true;
}

auto geom = Extrude(profile, extrusionNormal, extrudeDistance,
                    localPlaneNormal, localPlanePos);  // plane caps the prism's bottom
if (flipWinding) { /* swap each triangle's first two indices */ }

mesh.transformation = position;   // cutter Position applied AT THE END
```

Key contrasts with our implementation:
- Everything stays in **cutter-local** until the end; `mesh.transformation = position` is applied during boolean composition.
- Fixed extrusion distance (`EXTRUSION_DISTANCE_HALFSPACE_M`, ~50 m) — *not* sized to the host.
- The plane is passed into `Extrude` so it caps the prism's bottom cleanly.
- Explicit CCW normalisation of the input polygon.
- Author admits with a `// TODO: this is getting problematic.....` comment, so even their approach has rough edges.

### BooleanClippingResult — strictly SEQUENTIAL
```cpp
case schema::IFCBOOLEANCLIPPINGRESULT:
case schema::IFCBOOLEANRESULT: {
    auto firstMesh  = GetMesh(firstOperandID);   // recursive
    auto secondMesh = GetMesh(secondOperandID);
    auto origin = GetOrigin(firstMesh, _expressIDToGeometry);
    auto flatFirst  = flatten(firstMesh,  _expressIDToGeometry, translate(-origin));
    auto flatSecond = flatten(secondMesh, _expressIDToGeometry, translate(-origin));
    IfcGeometry resultMesh = BoolProcess(flatFirst, flatSecond, "DIFFERENCE", _settings);
    mesh.transformation = translate(origin);  // restore origin
    return mesh;
}
```

**One CSG op per IFC `IfcBooleanResult` node**. Chains are evaluated bottom-up: deepest result first, then each enclosing result subtracts its half-space from the running mesh. No batching at all.

Other web-ifc tricks worth noting:
- They translate operands to the host's centroid before CSG (`-origin` / `+origin`) to keep coordinates near zero for float precision.
- They explicitly `flatten()` multi-part operands — applying any child Position transforms — before handing meshes to the CSG kernel.

---

## 4. Our implementation — what we get wrong

`rust/geometry/src/processors/boolean.rs`

### What we do
- Process chains via `collect_polygonal_chain`: walks the chain, accumulates every consecutive `IfcPolygonalBoundedHalfSpace` cutter, builds each as a prism (`build_polygonal_bounded_half_space_mesh`), then **mesh-merges** all prisms and does **one** BSP CSG `subtract_mesh(host, merged_cutter)`.
- `build_polygonal_bounded_half_space_mesh` projects the polygon onto the slope plane in **world** coordinates and extrudes a tilted prism from there. We mix the plane (world) and the polygon (cutter-local) in one pass.

### Where it breaks

1. **Mesh-merging multiple closed prisms is not the same as their CSG union.** When chained cutters overlap in XY (Institute-Var-2 Wand-010 has cutters `[‑0.01,18]`, `[17,25]`, `[17,25]` duplicate, `[24,42.01]` — duplicates and overlaps), the merged mesh is **non-manifold** (overlapping closed solids with intersecting faces). BSP CSG on a non-manifold cutter produces wrong results. This is the root of the boundary slivers.

2. **Our `build_polygonal_bounded_half_space_mesh` worked in mixed frames.** Both ifcopenshell and web-ifc keep the cutter geometry in its own local frame until the end. We project the polygon directly into world via the plane's location, which makes the prism vertices coordinate-dependent and easier to get subtly wrong (winding, direction of extrusion).

3. **No epsilon padding.** Both reference kernels add ε = `1e-5` somewhere — CGAL pads the bounding box, OCCT inflates via its booleans' internal tolerance, web-ifc has flip-winding logic that effectively adds tolerance via the inverted-distance trick. We currently have nothing, so a host vertex landing exactly on a polygon edge ends up on the "wrong" side of BSP's `EPSILON=1e-5` classifier.

4. **No host-relative origin normalisation.** Web-ifc translates both operands by `-origin` before CSG to keep coordinates near zero. We feed BSP world-space coordinates that can be tens of meters from origin, costing precision in plane-classification.

### Why my earlier attempts failed

- **"Extrude along Position.Z" fix (the spec-correct change)**: helped Institute walls because their plane is significantly tilted (~22°). Broke FZK gable tests because the FZK gables had been visually right under the *old* `material_side_dir` extrusion — that old behaviour happened to coincide with web-ifc's "fixed extrusion distance, plane caps the prism" by accident on the specific gable geometry. Verdict: spec-correct, but exposes the deeper issue.
- **"Inflate polygon by 1 mm"**: catastrophic regression — proved that just inflating the polygon does not help. The mesh-merge of inflated overlapping prisms made the non-manifold problem worse, not better.

---

## 5. Properly-scoped fix

Three rewrites, in increasing scope, to bring us in line with the references.

### Fix A — SEQUENTIAL chain processing (the web-ifc way)
- Drop `collect_polygonal_chain`'s batching path entirely.
- Recurse one `IfcBooleanClippingResult` at a time. Each recursive frame: build cutter mesh, do **one** `subtract_mesh(host, cutter)`, return the result up to the parent.
- Pros: removes the non-manifold-cutter root cause for free. Matches web-ifc exactly. Matches ifcopenshell when the chain has > 8 half-spaces.
- Cons: each step's host gets more triangles → BSP polygon cap (`MAX_CSG_POLYGONS_PER_MESH = 128`) may be hit on the FZK round-window case that motivated the original batching (issue #635). Mitigation: the post-merge coplanar consolidation we already have should keep counts in check between steps.

### Fix B — Restructure `build_polygonal_bounded_half_space_mesh` per web-ifc
- Stop projecting the polygon to world. Build the cutter in **cutter-local** coords.
- Transform the plane (point + normal) into cutter-local using the inverted Position.
- Extrude polygon along cutter-local `+Z` by a fixed distance (50 m is fine), with the plane providing the lower cap.
- Apply the cutter Position once at the end as a single transform on the resulting mesh.
- This removes whole classes of subtle coordinate-frame bugs.

### Fix C — Add ε padding consistent with ifcopenshell
- Either pad the polygon outward by 1 mm Minkowski-style (we already tried this naively — needs to happen ONLY for single-cutter sequential subtracts, not for batched merge), or
- Snap the host's vertices that lie within ε of any cutter face onto that face before CSG (forces unambiguous classification).
- OR raise BSP `EPSILON` from `1e-5` to `1e-4` for this code path only.

### Recommended order
1. **Land Fix A first.** Removes the non-manifold-cutter root cause and brings our chain behaviour in line with web-ifc. Run the correctness harness on Institute and FZK to confirm Institute slivers go away and FZK gables stay intact. If the issue-#635 round window blows the polygon cap, add a fallback that batches *only* when all cutters in the chain are coplanar AND non-overlapping (then the merge IS manifold).
2. **Land Fix B** as a quality refactor — the new code lives entirely in cutter-local, which makes the path easier to reason about and matches both references.
3. **Land Fix C** only if there are residual boundary slivers AFTER Fix A. Likely there won't be — sequential subtracts don't share the boundary-classification problem of batched merges.

---

## 6. Open questions before committing to a refactor

1. How does the `correctness/` harness score Wand-010 today vs after Fix A? Expectation: hull-volume-ratio drops from 3.115 → ~1.0, voxel-IoU rises from 0.268 → 0.9+.
2. Will Fix A break the issue-#635 fast-path that motivated the batching? Need to read the failing case (round window + chained gable clip) and decide whether the cap-aware fallback is needed.
3. Does the post-merge consolidation interact correctly with sequential subtracts? It should run AFTER the final subtract, not between intermediate ones.
4. Native (Manifold-CSG) vs WASM (BSP) — both kernels likely benefit from Fix A, but the polygon-cap concern is BSP-only.

---

## 7. References

- IFC 4.3 spec — [IfcHalfSpaceSolid](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcHalfSpaceSolid.htm), [IfcPolygonalBoundedHalfSpace](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcPolygonalBoundedHalfSpace.htm), [IfcBooleanResult](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcBooleanResult.htm), [IfcBooleanClippingResult](https://standards.buildingsmart.org/IFC/RELEASE/IFC4_3/HTML/lexical/IfcBooleanClippingResult.htm)
- ifcopenshell — `src/ifcgeom/mapping/IfcPolygonalBoundedHalfSpace.cpp`, `IfcHalfSpaceSolid.cpp`, `IfcBooleanResult.cpp`; `src/ifcgeom/kernels/cgal/CgalKernel.cpp`
- web-ifc — `src/cpp/web-ifc/geometry/IfcGeometryProcessor.cpp` cases `IFCPOLYGONALBOUNDEDHALFSPACE`, `IFCBOOLEANCLIPPINGRESULT`, `IFCBOOLEANRESULT`; `src/cpp/web-ifc/geometry/operations/boolean-utils/`
