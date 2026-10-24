// SPDX-License-Identifier: MPL-2.0
// #7955: distinguish a fitted Boolean edge from tessellation placement error.
#include "patch_accuracy_diagnostic.hpp"
#include "copy.hpp"
#include <algorithm>
#include <SmApiBrep.h>
#include <SmBrep.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <SmPoly.h>
#include <SmTol.h>
#include <SmBSplineCurve.h>
#include <SmBSplineSurface.h>
#include <cmath>
#include <cstdio>
#include <memory>
namespace {
double graph_residual(const SmPoint3d& p) {
    return p.z-(2+p.x*(2-p.x)*p.y*(2-p.y));
}
void point(const char* tag,const SmPoint3d& p) {
    std::fprintf(stderr,"patch diagnostic %s xyz=(%.17g,%.17g,%.17g) graph_residual=%.17g\n",
        tag,p.x,p.y,p.z,graph_residual(p));
}
void edge_trace(SmFace* face,unsigned face_id,SmEdgeuse* use,const SmPoint3d& target) {
    auto* edge=use->GetEdge();
    SmBoolean found=FALSE; double parameter=0,distance=0;
    const auto status=edge->ClosestPoint(target,found,parameter,distance);
    if(status!=SM_SUCCESS || !found || !std::isfinite(distance) || distance>0.01) return;
    const double a=use->GetEdgeParam(0),b=use->GetEdgeParam(1);
    if(!std::isfinite(parameter) || a==b) return;
    const double normalized=(parameter-a)/(b-a);
    std::fprintf(stderr,"patch diagnostic edge face=%u surface_type=%ld curve_type=%ld "
        "face_tol=%.17g edge_tol=%.17g face_approx_tol=%.17g closest_distance=%.17g t=%.17g normalized=%.17g trim=%d\n",
        face_id,static_cast<long>(face->GetSurface()->GetType()),static_cast<long>(edge->GetCurve()->GetType()),
        double(face->GetTolerance()),double(edge->GetTolerance()),double(SmTol::GetApproxTol3d(face)),
        distance,parameter,normalized,
        use->GetUVTrimCurve()!=nullptr);
    SmPoint3d curve,uv,surface;
    if(edge->GetCurve()->EvaluatePoint(parameter,curve)==SM_SUCCESS) point("closest_curve",curve);
    // FALSE forbids creation of a missing trim; diagnostics must not heal it.
    if(use->GetUVTrimCurve() && use->NormalizedEvaluate(normalized,TRUE,uv,nullptr,FALSE)==SM_SUCCESS &&
        face->GetSurface()->EvaluatePoint(SmPoint2d(uv.x,uv.y),surface)==SM_SUCCESS) {
        std::fprintf(stderr,"patch diagnostic trim_uv=(%.17g,%.17g)\n",uv.x,uv.y);
        point("trim_surface",surface);
        if(edge->GetCurve()->EvaluatePoint(parameter,curve)==SM_SUCCESS)
            std::fprintf(stderr,"patch diagnostic curve_surface_gap=%.17g\n",curve.DistanceBetween(surface));
    }
    // Fixed bounded sweep distinguishes a single tessellation sample from a
    // persistent edge representation error. These are observations, not a proof.
    double worst=-1e300; unsigned successful=0;
    for(unsigned i=0;i<=64;++i) {
        SmPoint3d sample;
        if(use->NormalizedEvaluate(double(i)/64,FALSE,sample,nullptr,FALSE)!=SM_SUCCESS) continue;
        ++successful; worst=std::max(worst,graph_residual(sample));
    }
    std::fprintf(stderr,"patch diagnostic edge_samples=%u max_graph_residual=%.17g\n",successful,worst);
}
}
void diagnose_patch_accuracy(SmBrep* output,double x,double y,double z) {
    // Queries may build SDK caches: isolate every diagnostic from the oracle.
    auto copy=checked_brep_copy(output);
    auto tess_copy=checked_brep_copy(output);
    const SmPoint3d target(x,y,z);
    point("failed_adapter_vertex",target);
    SmTArray<SmFace*> faces; copy->GetFaces(faces);
    if(faces.GetSize()>64) { std::fprintf(stderr,"patch diagnostic face budget exceeded\n"); return; }
    for(ULONG f=0;f<faces.GetSize();++f) {
        SmTArray<SmEdgeuse*> uses; faces[f]->GetUpwardEdgeuses(uses);
        if(uses.GetSize()>128) { std::fprintf(stderr,"patch diagnostic edge budget exceeded\n"); return; }
        for(auto* use:uses) edge_trace(faces[f],f,use,target);
    }
    // Same raw tessellator and parameters as the adapter. No triangulation or
    // coordinate edits. Back pointers are labels unless SDK says they are valid.
    SmTessellationParams params; params.dChordHeightTol=0.001;
    params.dCurveAngleTolDeg=5; params.dSurfaceAngleTolDeg=5;
    SmPolyBrep* raw=nullptr; SmTessellationReport report;
    const auto status=SmApiTessellate(tess_copy.get(),raw,params,FALSE,nullptr,&report);
    std::unique_ptr<SmPolyBrep> poly(raw);
    std::fprintf(stderr,"patch diagnostic raw_tess_status=%ld\n",static_cast<long>(status));
    if(status!=SM_SUCCESS || !poly) return;
    SmTArray<SmPolyVertex*> vertices; poly->GetPolyVertices(vertices);
    if(vertices.GetSize()>1000000) { std::fprintf(stderr,"patch diagnostic vertex budget exceeded\n"); return; }
    SmPolyVertex* nearest=nullptr; double best=1e300;
    for(auto* vertex:vertices) {
        const double distance=vertex->GetPoint().DistanceBetween(target);
        if(distance<best) { best=distance; nearest=vertex; }
    }
    if(!nearest) return;
    point("nearest_raw_poly_vertex",nearest->GetPoint());
    std::fprintf(stderr,"patch diagnostic raw_distance=%.17g valid_backptr=%d has_original_vertex=%d "
        "has_original_edgeuse=%d failures=%lu\n",best,int(nearest->GetOKBackPtrs()),
        nearest->GetOriginalVertex()!=nullptr,nearest->GetOriginalEdgeuse()!=nullptr,
        static_cast<unsigned long>(report.failures.GetSize()));
}
