// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <array>
#include <vector>
struct AdapterMesh;

// The SDK lists polygons, vertices and triangle corners in an order that
// follows heap addresses, so two runs on the same input can enumerate (and,
// for planar quads, triangulate) the same solid differently. These steps put
// every adapter mesh into one canonical order and fix the diagonal of planar
// two-triangle faces. No position, source-face ID or boundary changes; flat
// normals are recomputed (flat_normal). Not canonicalized, so still dependent on
// the SDK's order: the triangulation of a planar face of more than two
// triangles, of a curved face other than a cylinder, and of a cylinder pair that
// normalize_mesh_diagonals skips. Vertex order follows exact f64 bits, so
// native and WASM builds may order the same solid differently.

// The flat unit normal of triangle (a, b, c), following its winding, from the
// longest of its three corner cross products. False when all three are zero.
bool flat_normal(const std::array<double,3>& a, const std::array<double,3>& b,
    const std::array<double,3>& c, std::array<double,3>& out);

// Vertices in (x, y, z) order (-0 before +0; coincident vertices by their
// incident triangles), each triangle rotated to start at its smallest vertex
// (winding kept), triangles sorted by (source face, v0, v1, v2).
void order_mesh(AdapterMesh& mesh);

// A planar source face tessellated as exactly two triangles is split along
// the diagonal through its lowest vertex in (x, y, z) order, when that split
// is strictly convex and that diagonal is not already a mesh edge. Otherwise
// the SDK's diagonal is kept. Requires
// order_mesh first, so the smallest vertex ID is the lowest vertex.
void canonical_planar_quads(AdapterMesh& mesh, const std::vector<bool>& planar_faces);
