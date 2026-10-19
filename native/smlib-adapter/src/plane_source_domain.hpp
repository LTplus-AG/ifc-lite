// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "plane_interval.hpp"
#include <SmFace.h>
namespace plane_source_proof {
// Private candidate proof identity, NOT a wire method bit or authored UV trim.
// No persistence, callback ancestry or externally edited graph authority.
enum class Method { axis_rectangle_unit_weight_v1 };
struct EdgeRecord {
    std::array<double,8> controls{};
    std::array<double,4> knots{};
    std::array<double,2> interval{};
    std::array<double,3> start{},end{},line_origin{},line_axis{};
    std::array<double,2> step{};
    double scale=0;
    bool analytic=false,inside_out=false;
};
struct Rectangle {
    Method method=Method::axis_rectangle_unit_weight_v1;
    plane_numeric::Bounds bounds=plane_numeric::vacant();
    // Tensor order: P00 P01 P10 P11, each homogeneous xyzw.
    std::array<double,16> controls{};
    std::array<double,4> u{},v{};
    std::array<EdgeRecord,4> edges{};
    std::array<unsigned,4> start_corner{},end_corner{};
    uint32_t source_face=0;
    unsigned u_axis=3,v_axis=3,normal_axis=3;
    unsigned loops=1,holes=0,edge_count=4,control_count=12;
    // Symbolic inverse: u=u0+(X-P00[u_axis])/(P10[u_axis]-P00[u_axis])*(u1-u0),
    // likewise v using P01. Comparisons prove each ratio lies in [0,1].
    // uv_hull conservatively stores the FULL supported rectangle; no fit.
    std::array<plane_numeric::Interval,2> uv_hull{};
};
// Source-owned SDK topology only. Throws status7 for every unresolved class.
// Internal mechanism only: use certify_plane_source_rectangle from plane_domain
// for whole-source preflight, source inventory and present UV support checks.
Rectangle certify_axis_rectangle(SmFace* face);
}
