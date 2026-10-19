// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "plane_interval.hpp"
#include <SmBrep.h>
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
void validate_plane_solid(SmBrep* solid);
