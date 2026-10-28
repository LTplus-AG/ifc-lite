// SPDX-License-Identifier: MPL-2.0
#pragma once
struct AdapterMesh;

// Normalize the diagonal of convex, same-source-face triangle pairs without
// moving vertices or changing their boundary. Throws on work-budget exhaustion.
void normalize_mesh_diagonals(AdapterMesh& mesh);
