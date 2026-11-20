// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <array>
#include <vector>
struct AdapterMesh;

// The SDK lists polygons, vertices and triangle corners in an order that
// follows heap addresses, and its coordinates themselves differ between runs
// by about one ULP with heap layout. These steps give every adapter mesh one
// canonical topology that such noise does not change: every comparison that
// picks an order or breaks a tie uses coordinates and lengths on a fine grid
// (canonical_grid), with exact values only as the last tie-break. No emitted
// value is rounded: positions and source-face IDs are the SDK's, flat normals
// are recomputed (flat_normal). Validity tests stay exact. Not canonicalized,
// so still dependent on the SDK's order: the triangulation of a curved face
// other than a cylinder, of a cylinder pair that normalize_mesh_diagonals
// skips (including a pair whose two diagonals tie on the grid: the flip needs
// a strictly shorter grid length, so a warped cylinder quad at large
// object-space coordinates can keep the SDK's split and differ between native
// and WASM), and of a planar face that canonical_planar_faces declines.
// Residual noise cases: a coordinate or length within one ULP of a grid
// half-step can still change key (about 1 in 2^15 noisy values at the minimum
// step), the step itself can flip when its base value lies within noise
// of a power of two, and a vertex whose distance from a diagonal is within
// about 2^-8 relative of the near threshold (|d / threshold - 1| <~ 2^-8)
// can change the near rule's verdict.

// Step of the grid all canonical sort keys use: a power of two, at least
// 2^16 ULP of the mesh's largest |coordinate|, otherwise between 2^-30 and
// 2^-29 of its bounding-box extent. Values are never rounded to it.
double canonical_grid(const AdapterMesh& mesh);

// The flat unit normal of triangle (a, b, c), following its winding, from the
// longest of its three corner cross products. False when all three are zero.
bool flat_normal(const std::array<double,3>& a, const std::array<double,3>& b,
    const std::array<double,3>& c, std::array<double,3>& out);

// Vertices in (x, y, z) grid-key order (equal keys by their incident corners,
// then exactly, -0 before +0), each triangle rotated to start at its smallest vertex
// (winding kept), triangles sorted by (source face, v0, v1, v2).
void order_mesh(AdapterMesh& mesh);

// Every planar (SmPlane) source face of two or more triangles is
// retriangulated from its vertex set and boundary alone, so the SDK's split
// no longer matters: a greedy constrained triangulation adds interior
// diagonals in (grid length, lower vertex, upper vertex) order, skipping one
// that passes through a vertex, crosses an accepted edge, leaves the face
// (holes and pinch vertices included) or is an edge of a face that is not
// retriangulated (or any face's boundary), and one that passes within 2^-8
// grid steps (at least 2^8 ULP) of a vertex, where the SDK's noise decides
// which side it passes; if that leaves no valid triangulation, the greedy
// runs again without the last rule. A quad therefore takes its shorter
// diagonal, and on a tie (a rectangle) the one through its lowest vertex.
// A face with two vertices on one projected point is declined: a guard
// against an invalid comparator (undefined behaviour in the sort), not a
// determinism guard; under noise such a folded face can still give several
// topologies (the SDK's split, or none when it is declined).
// Every geometric decision uses one exact orientation predicate, so
// near-collinear vertices (rotated or georeferenced faces) cannot make two
// tests disagree. A face is left as the SDK split it when the result does not
// reproduce its triangle count, directed edge use and area, when it has more
// than 256 vertices, or when its edges are not manifold. Interior diagonals of
// other retriangulated faces are not avoided: they can only coincide in
// overlapping (degenerate) faces, which then share one canonical split.
// A two-triangle face uses the same ranking in closed form (requad), with
// exact orientation checks but without the greedy's area, normal and edge-use
// checks, so a near-collinear quad can get a split where the greedy would
// decline; its last resort (a near diagonal) also requires both flat normals
// to follow the face. Cost is O(V^3) per
// face in the worst case (about 11 ms for 256 vertices, 1 us for a quad).
// Requires order_mesh first (canonical vertex IDs, faces contiguous).
void canonical_planar_faces(AdapterMesh& mesh, const std::vector<bool>& planar_faces);
