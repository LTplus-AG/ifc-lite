// SPDX-License-Identifier: MPL-2.0
// #7955: inspect the retained intersection, independently of display meshing.
#include "patch_edge_oracle.hpp"
#include <SmBrep.h>
#include <SmEdge.h>
#include <SmBSplineCurve.h>
#include <cmath>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
namespace {
void require(bool value,const char* message) {
    if(!value) { std::fprintf(stderr,"plane oracle FAIL: %s\n",message); std::exit(1); }
}
}
void require_patch_edge_accuracy(SmBrep* output) {
    SmTArray<SmEdge*> edges; output->GetEdges(edges);
    require(edges.GetSize()<=64,"bounded patch edge oracle");
    unsigned witnesses=0;
    double worst=0;
    for(auto* edge:edges) {
        const auto domain=edge->GetInterval();
        // Dense deterministic source-derived witnesses, not an assertion about
        // an SDK setting. This includes the original failing t fraction 61/64.
        for(unsigned i=0;i<=64;++i) {
            SmPoint3d p;
            require(edge->GetCurve()->EvaluatePoint(domain.Evaluate(double(i)/64),p)==SM_SUCCESS,
                "evaluate actual retained patch edge");
            require(std::isfinite(p.x) && std::isfinite(p.y) && std::isfinite(p.z),"finite retained patch edge");
            if(std::abs(p.x-.5)>1e-6 || p.z<=2 || p.y<=0 || p.y>=2) continue;
            ++witnesses;
            const double error=std::abs(p.z-(2+p.x*(2-p.x)*p.y*(2-p.y)));
            worst=std::max(worst,error);
            if(error>1e-6) std::fprintf(stderr,"patch edge error=%.17g xyz=(%.17g,%.17g,%.17g) limit=1e-6\n",
                error,p.x,p.y,p.z);
            require(error<=1e-6,"retained patch edge respects fixed source graph accuracy");
        }
    }
    require(witnesses>=63,"retained curved cut edge reached");
    std::printf("patch edge oracle samples=%u max_error=%.17g limit=1e-6\n",witnesses,worst);
}
