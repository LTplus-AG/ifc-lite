// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <SmBrep.h>
// Private finite-plane operation policy, in the adapter's existing local units.
// These control construction, never source topology tolerances or acceptance.
inline constexpr double plane_boundary_accuracy = 1e-6;
inline constexpr double plane_construction_accuracy = plane_boundary_accuracy/16;
SmStatus intersect_plane_with_accuracy(SmBrep* host,SmBrep* cutter,SmBrep*& result);
