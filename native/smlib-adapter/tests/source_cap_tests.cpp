// SPDX-License-Identifier: MPL-2.0
// #7955 / 6e8c90bd: authentic planar construction splits a covering plane.
#include "source_construction.hpp"
#include "context_metadata.hpp"
#include "failure.hpp"
#include <SmApiGeneral.h>
#include <SmBSplineCurve.h>
#include <SmFace.h>
#include <SmVertex.h>
#include <cstring>
#include <cmath>
#include <stdexcept>
namespace face_lineage {
struct SourceConstructionTestAccess {
    static void target(SourceConstruction& s,SmBrep& b) { s.body=&b; }
    static void begin(SourceConstruction& s,uint32_t n) { s.begin_cap(n); }
    static void finish(SourceConstruction& s,const SmTArray<SmFace*>& f) { s.finish_cap(f); }
    static bool failed(const SourceConstruction& s) { return s.failed; }
    static void cap(SourceConstruction& s,SmTArray<SmCurve*>& c) { s.cap(c,SourceRole::StartCap); }
};
}
namespace {
using namespace face_lineage;
void require(bool ok,const char* why) { if(!ok) throw std::runtime_error(why); }
void rectangle(SmContext& context,SmTArray<SmCurve*>& curves,double x,double y,double w,double h) {
    const SmPoint3d points[4]={{x,y,0},{x+w,y,0},{x+w,y+h,0},{x,y+h,0}};
    for(unsigned i=0;i<4;++i) {
        SmBSplineCurve* line=nullptr;
        require(SmBSplineCurve::CreateLineSegment(context,3,points[i],points[(i+1)%4],line)==SM_SUCCESS && line,
            "cap fixture builds actual rational curves");
        curves.Add(line);
    }
}
}
void run_source_cap_case(const char* name) {
    SmApiCreateContext(); auto& context=*SmApiGetOrCreateContext();
    auto body=raw_context::construct_brep(&context),foreign=raw_context::construct_brep(&context);
    body->m_bEditingEnabled=TRUE; foreign->m_bEditingEnabled=TRUE;
    SmTArray<SmCurve*> curves; rectangle(context,curves,0,0,4,4);
    const bool hole=std::strcmp(name,"cap-hole")==0;
    if(hole || std::strcmp(name,"cap-bound")==0) rectangle(context,curves,1,1,2,2);
    SourceConstruction issuer(context); SourceConstructionTestAccess::target(issuer,*body);
    if(std::strcmp(name,"cap-positive")==0 || hole) {
        bool accepted=true;
        try { SourceConstructionTestAccess::cap(issuer,curves); }
        catch(const AdapterFailure&) { accepted=false; }
        require(accepted,"cap construction requires actual complete split receipts");
        auto roles=issuer.finish(*body);
        require(roles.size()==1 && roles[0].role==SourceRole::StartCap && roles[0].face->GetBrep()==body.get(),
            "actual cap output retains its construction role");
        SmTArray<SmVertex*> vertices; roles[0].face->GetVertices(vertices);
        require(vertices.GetSize()==(hole?8u:4u),"cap boundary preserves all authored corners and holes");
        for(auto* v:vertices) {
            const auto p=v->GetPoint();
            auto near=[](double a,double b) { return std::abs(a-b)<=1e-9; };
            require(near(p.z,0) && (((near(p.x,0) || near(p.x,4)) && (near(p.y,0) || near(p.y,4))) ||
                (hole && (near(p.x,1) || near(p.x,3)) && (near(p.y,1) || near(p.y,3)))),
                "cap boundary preserves all authored corners and holes");
        }
    } else {
        const bool unscoped=std::strcmp(name,"cap-unscoped")==0;
        const bool wrong_output=std::strcmp(name,"cap-output")==0;
        if(!unscoped) SourceConstructionTestAccess::begin(issuer,std::strcmp(name,"cap-bound")==0?1:uint32_t(curves.GetSize()));
        auto& target=std::strcmp(name,"cap-foreign")==0?*foreign:*body;
        SmTArray<SmFace*> output;
        require(target.CreatePlanarFacesWith3DCurves(target.GetInfiniteRegion(),curves,target.GetTolerance(),output)==SM_SUCCESS,
            "actual cap SDK construction executes");
        if(wrong_output) {
            // Real output removed from the SDK's returned list; no fake event.
            output.ReSet(); bool refused=false;
            try { SourceConstructionTestAccess::finish(issuer,output); }
            catch(const AdapterFailure&) { refused=true; }
            require(refused,"cap publication requires actual returned live descendant");
        } else require(SourceConstructionTestAccess::failed(issuer),"cap split requires exact active construction body");
    }
}
