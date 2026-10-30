// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <SmAxis2Placement.h>
#include <optional>
#include <vector>
struct AdapterMesh;
struct CylinderPatch { SmAxis2Placement frame; double radius; };

// Normalize the diagonal of convex, same-source-face triangle pairs without
// moving vertices or changing their boundary. Throws on work-budget exhaustion.
void normalize_mesh_diagonals(AdapterMesh& mesh, double angle_degrees, double chord,
    const std::vector<std::optional<CylinderPatch>>& cylinders);
