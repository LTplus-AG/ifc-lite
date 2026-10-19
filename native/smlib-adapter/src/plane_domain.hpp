// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "plane_interval.hpp"
#include "plane_source_domain.hpp"
#include <SmBrep.h>
struct PlaneDomain {
    plane_numeric::Bounds bounds=plane_numeric::vacant();
    double tolerance=0;
    uint32_t faces=0,edges=0,coefficients=0;
    uint32_t methods=0,cylinder_count=0;
    std::array<ifclite_smlib_cylinder_domain,IFCLITE_SMLIB_PLANE_MAX_CYLINDERS> cylinders{};
    uint32_t rectangle_count=0;
    std::array<ifclite_smlib_rectangle_domain,IFCLITE_SMLIB_PLANE_MAX_RECTANGLES> rectangles{};
    bool empty=false;
};
// No tessellation, fitting, conversion, bounding cache or source writes.
PlaneDomain certify_plane_domain(SmBrep* source);
void validate_plane_solid(SmBrep* solid,const char* stage);
// Private additive proof seam; does not issue/alter the C ABI certificate.
// Reuses the non-evaluating WHOLE-source preflight before inspecting a face.
plane_source_proof::Rectangle certify_plane_source_rectangle(SmBrep* source,SmFace* face);
// Parent-owned plane.cpp calls this immediately after copying cylinder records.
// Only record-bearing derived domains receive v2; v1 remains byte-identical.
void populate_plane_source_records(const PlaneDomain& domain,ifclite_smlib_plane_certificate& certificate);
