// SPDX-License-Identifier: MPL-2.0
// Program invariant: unsupported existing source representations refuse before
// SDK evaluation or lazy materialization. No invalid fixture supplies geometry
// for a successful result. Actual SDK execution remains UNRUN here.
#include "context_metadata.hpp"
#include "copy.hpp"
#include "plane.hpp"
#include "plane_domain.hpp"
#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmBSplineCurve.h>
#include <SmEdgeuse.h>
#include <SmVertex.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
namespace {
void require(bool value,const char* message) {
    if(!value) { std::fprintf(stderr,"plane source preflight FAIL: %s\n",message); std::exit(1); }
}
bool bits(double a,double b) { return std::memcmp(&a,&b,sizeof(a))==0; }
bool same(raw_context::Metadata a,raw_context::Metadata b) {
    return bits(a.size,b.size) && bits(a.ratio,b.ratio) && bits(a.zone,b.zone);
}
class LazyAbsentTrim final:public SmBSplineCurve {
    unsigned& calls;
public:
    explicit LazyAbsentTrim(unsigned& count):calls(count) {}
    SmStatus MakeNurb() override { ++calls; return SM_ERR; }
};
void absent_trim(bool derived) {
    auto* context=SmApiGetOrCreateContext(); raw_context::Restore preserve(context);
    SmBrep* raw=nullptr;
    require(SmApiCreateBox(SmVector3d(0,0,0),2,2,2,raw)==SM_SUCCESS && raw,"actual SDK source topology");
    std::unique_ptr<SmBrep> source(raw);
    SmTArray<SmEdgeuse*> uses; source->GetEdgeuses(uses);
    require(uses.GetSize()>0 && uses[0]->GetUVTrimCurve(),"replace a real existing source UV trim");
    unsigned lazy_calls=0;
    SmBSplineCurve* broken=derived?static_cast<SmBSplineCurve*>(new (*context) LazyAbsentTrim(lazy_calls)):
        new (*context) SmBSplineCurve();
    require(broken->GetGwNurbPointer()==nullptr,"actual generic trim exists but has no NURBS");
    uses[0]->SetUVTrimCurve(broken,0,TRUE); // Ownership retained by the actual source.
    require(uses[0]->GetUVTrimCurve()==broken,"fixture contains present rather than null trim");
    const auto source_metadata=raw_context::Access<SmBrep>::get(*source);
    const auto context_metadata=raw_context::Access<SmContext>::get(*context);
    const auto face_count=source->GetNumFaces(),edge_count=source->GetNumEdges();
    SmTArray<SmVertex*> vertices; source->GetVertices(vertices);
    std::vector<SmPoint3d> positions; for(auto* v:vertices) positions.push_back(v->GetPoint());
    for(bool clip:{false,true}) {
        bool refused=false; ifclite_smlib_plane_certificate certificate{};
        try {
            if(clip) {
                const double plane[]={0.5,0,0,1,0,0};
                auto result=clip_finite_plane(source.get(),plane,1,IFCLITE_SMLIB_INTERSECTION,certificate);
            } else { certify_plane_domain(source.get()); }
        } catch(const SweepFailure& e) { refused=e.status==IFCLITE_SMLIB_UNSUPPORTED; }
        require(refused && certificate.version==0 && !kernel_domain_is_tainted(),"typed status7 refusal without publication or taint");
        require(lazy_calls==0 && broken->GetGwNurbPointer()==nullptr && uses[0]->GetUVTrimCurve()==broken,
            "source trim identity and absent data unchanged; no MakeNurb attempted");
        require(same(source_metadata,raw_context::Access<SmBrep>::get(*source)) &&
            same(context_metadata,raw_context::Access<SmContext>::get(*context)),"raw source/shared metadata unchanged on preflight refusal");
        require(source->GetNumFaces()==face_count && source->GetNumEdges()==edge_count,"source topology unchanged on refusal");
        SmTArray<SmVertex*> after; source->GetVertices(after);
        require(after.GetSize()==positions.size(),"source vertex count unchanged");
        for(ULONG i=0;i<after.GetSize();++i) {
            const auto p=after[i]->GetPoint();
            require(bits(p.x,positions[i].x) && bits(p.y,positions[i].y) && bits(p.z,positions[i].z),
                "source coordinates unchanged without evaluating invalid trim");
        }
    }
}
}
void run_plane_preflight_tests() { absent_trim(false); absent_trim(true); }
