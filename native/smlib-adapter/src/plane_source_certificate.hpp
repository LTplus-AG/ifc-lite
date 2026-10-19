// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "plane_source_domain.hpp"
namespace plane_source_proof {
inline ifclite_smlib_rectangle_domain certificate_record(const Rectangle& p) {
    ifclite_smlib_rectangle_domain r{};
    r.version=1; r.source_face=p.source_face; r.u_axis=p.u_axis; r.v_axis=p.v_axis; r.normal_axis=p.normal_axis;
    r.loops=p.loops; r.holes=p.holes; r.edge_count=p.edge_count; r.control_count=p.control_count;
    std::copy(p.controls.begin(),p.controls.end(),r.controls);
    std::copy(p.u.begin(),p.u.end(),r.u); std::copy(p.v.begin(),p.v.end(),r.v);
    for(unsigned d=0;d<3;++d) { r.bounds[d]=p.bounds[d].lo; r.bounds[3+d]=p.bounds[d].hi; }
    r.uv_hull[0]=p.uv_hull[0].lo; r.uv_hull[1]=p.uv_hull[1].lo;
    r.uv_hull[2]=p.uv_hull[0].hi; r.uv_hull[3]=p.uv_hull[1].hi;
    const double inverse[]={p.u[0],p.u[3],p.controls[p.u_axis],p.controls[8+p.u_axis],
        p.v[0],p.v[3],p.controls[p.v_axis],p.controls[4+p.v_axis]};
    std::copy_n(inverse,8,r.inverse);
    for(unsigned i=0;i<4;++i) {
        const auto& e=p.edges[i]; auto& out=r.edges[i];
        out.flags=(e.analytic?1u:0u)|(e.inside_out?2u:0u);
        out.start_corner=p.start_corner[i]; out.end_corner=p.end_corner[i];
        std::copy(e.controls.begin(),e.controls.end(),out.controls);
        std::copy(e.knots.begin(),e.knots.end(),out.knots);
        std::copy(e.interval.begin(),e.interval.end(),out.interval);
        std::copy(e.start.begin(),e.start.end(),out.start); std::copy(e.end.begin(),e.end.end(),out.end);
        std::copy(e.line_origin.begin(),e.line_origin.end(),out.line_origin);
        std::copy(e.line_axis.begin(),e.line_axis.end(),out.line_axis);
        std::copy(e.step.begin(),e.step.end(),out.step); out.scale=e.scale;
    }
    return r;
}
static_assert(sizeof(ifclite_smlib_rectangle_edge)==IFCLITE_SMLIB_PLANE_RECTANGLE_EDGE_BYTES,"rectangle edge ABI");
static_assert(sizeof(ifclite_smlib_rectangle_domain)==IFCLITE_SMLIB_PLANE_RECTANGLE_BYTES,"rectangle ABI");
}
