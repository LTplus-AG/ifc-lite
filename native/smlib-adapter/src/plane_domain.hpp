// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "plane_interval.hpp"
#include <SmBrep.h>
#include <vector>
class SmFace;
struct PlaneDomain {
    plane_numeric::Bounds bounds=plane_numeric::vacant();
    double tolerance=0;
    uint32_t faces=0,edges=0,coefficients=0;
    uint32_t methods=0,cylinder_count=0;
    std::array<ifclite_smlib_cylinder_domain,IFCLITE_SMLIB_PLANE_MAX_CYLINDERS> cylinders{};
    bool empty=false;
};
// No tessellation, fitting, conversion, bounding cache or source writes.
PlaneDomain certify_plane_domain(SmBrep* source);
void validate_plane_solid(SmBrep* solid,const char* stage);
// Internal face contribution, before edge/vertex union or tolerance expansion.
plane_numeric::Bounds certify_plane_face_domain(SmFace* face,uint32_t index,PlaneDomain& domain);
// Read-only whole-source admission; returned flags bind GetFaces order.
// A flagged face needs explicit owned reconstruction and method8 reporting.
std::vector<bool> preflight_plane_source(SmBrep* source);
// Only after explicit owned reconstruction/validation, with COMPLETE trims.
PlaneDomain certify_owned_plane_domain(SmBrep* owned,const std::vector<bool>& reconstructed);
