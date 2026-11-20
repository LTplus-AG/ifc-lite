// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <vector>
struct AdapterMesh;

// The SDK lists polygons, vertices and triangle corners in an order that
// follows heap addresses, so two runs on the same input can enumerate (and,
// for planar quads, triangulate) the same solid differently. These steps put
// every adapter mesh into one canonical order and fix the diagonal of planar
// two-triangle faces. No position, source-face ID or boundary changes; flat
// normals are recomputed from each canonical corner order. A planar face of
// more than two triangles keeps the SDK's triangulation (not canonicalized).

// Vertices in (x, y, z) order (-0 before +0; coincident vertices by their
// incident triangles), each triangle rotated to start at its smallest vertex
// (winding kept), triangles sorted by (source face, v0, v1, v2).
void order_mesh(AdapterMesh& mesh);

// A planar source face tessellated as exactly two triangles is split along
// the diagonal through its lowest vertex in (x, y, z) order, when that split
// is strictly convex. Otherwise its only valid diagonal is kept. Requires
// order_mesh first, so the smallest vertex ID is the lowest vertex.
void canonical_planar_quads(AdapterMesh& mesh, const std::vector<bool>& planar_faces);
