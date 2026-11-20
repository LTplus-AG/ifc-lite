// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <array>
#include <vector>
struct AdapterMesh;

// The SDK lists polygons, vertices and triangle corners in an order that
// follows heap addresses, so two runs on the same input can enumerate and
// triangulate the same solid differently. These steps put every adapter mesh
// into one canonical order and give every planar face a canonical
// triangulation. No position, source-face ID or boundary changes; flat normals
// are recomputed (flat_normal). Not canonicalized, so still dependent on the
// SDK's order: the triangulation of a curved face other than a cylinder, of a
// cylinder pair that normalize_mesh_diagonals skips, and of a planar face that
// canonical_planar_faces declines (see there). Vertex order follows exact f64
// bits, so native and WASM builds may order the same solid differently.

// The flat unit normal of triangle (a, b, c), following its winding, from the
// longest of its three corner cross products. False when all three are zero.
bool flat_normal(const std::array<double,3>& a, const std::array<double,3>& b,
    const std::array<double,3>& c, std::array<double,3>& out);

// Vertices in (x, y, z) order (-0 before +0; coincident vertices by their
// incident triangles), each triangle rotated to start at its smallest vertex
// (winding kept), triangles sorted by (source face, v0, v1, v2).
void order_mesh(AdapterMesh& mesh);

// Every planar (SmPlane) source face of two or more triangles is
// retriangulated from its vertex set and boundary alone, so the SDK's split
// no longer matters: a greedy constrained triangulation adds interior
// diagonals in (3D squared length, lower vertex, upper vertex) order, skipping
// one that passes through a vertex, crosses an accepted edge, leaves the face
// (holes and pinch vertices included) or is an edge of a face that is not
// retriangulated (or any face's boundary). A quad therefore takes its shorter
// diagonal, and on a tie (a rectangle) the one through its lowest vertex.
// Every geometric decision uses one exact orientation predicate, so
// near-collinear vertices (rotated or georeferenced faces) cannot make two
// tests disagree. A face is left as the SDK split it when the result does not
// reproduce its triangle count, directed edge use and area, when it has more
// than 256 vertices, or when its edges are not manifold. Interior diagonals of
// other retriangulated faces are not avoided: they can only coincide in
// overlapping (degenerate) faces, which then share one canonical split.
// Cost is O(V^3) per face in the worst case: about 10 ms for 256 vertices.
// Requires order_mesh first (canonical vertex IDs, faces contiguous).
void canonical_planar_faces(AdapterMesh& mesh, const std::vector<bool>& planar_faces);
