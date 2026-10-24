// SPDX-License-Identifier: MPL-2.0
// #7955 round 3. Diagnostic-only raw SDK run: NEVER an adapter acceptance lane.
// Reproduce the first curved-control cylinder/identity affine/tessellation and
// record the split's complete event sequence without changing production guards.
#include "affine.hpp"
#include "copy.hpp"
#include "failure.hpp"
#include <SmApiGeneral.h>
#include <SmApiBrep.h>
#include <SmApiPrimitives.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <SmPoly.h>
#include <execinfo.h>
#include <unistd.h>
#include <array>
#include <cstdio>
#include <exception>
#include <memory>
namespace {
struct Observer:SmNotifyCallback {
    struct Row { long operation=0,type=0; SmObject *caller=nullptr,*a=nullptr,*b=nullptr,*c=nullptr; };
    std::array<Row,32768> rows{};
    size_t count=0;
    bool overflow=false,started=false,receipt=false;
    SmObject* first_edge=nullptr;
    void edge(const char* label,SmEdge* value) {
        const auto interval=value->GetInterval();
        std::fprintf(stderr,"subdivision %s edge=%p brep=%p curve=%p interval=[%.17g,%.17g] uses=%lu\n",
            label,static_cast<void*>(value),static_cast<void*>(value->GetBrep()),static_cast<void*>(value->GetCurve()),
            interval.GetMin(),interval.GetMax(),static_cast<unsigned long>(value->GetEdgeuseCount()));
        SmTArray<SmFace*> faces; value->GetFaces(faces);
        for(auto* face:faces) std::fprintf(stderr,"subdivision incident_face=%p surface=%p\n",
            static_cast<void*>(face),static_cast<void*>(face->GetSurface()));
    }
    SmStatus Execute(SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) noexcept override {
        if(count==rows.size()) { overflow=true; return SM_SUCCESS; }
        rows[count++]={long(op),caller?long(caller->GetType()):0,caller,a,b,c};
        // Slots are interpreted only for these documented topology operations.
        if(!started && op==SM_NO_PRE_EDIT && caller && caller->GetType()==SmEdge_TYPE && a==caller) {
            started=true; first_edge=caller; edge("before",static_cast<SmEdge*>(caller));
            void* frames[32]; const int n=::backtrace(frames,32);
            if(n>0) ::backtrace_symbols_fd(frames,n,STDERR_FILENO);
        }
        if(started && !receipt && op==SM_NO_SPLIT_IN_BREP && a==first_edge && b && c &&
            b->GetType()==SmEdge_TYPE && c->GetType()==SmEdge_TYPE) {
            receipt=true; edge("child1",static_cast<SmEdge*>(b)); edge("child2",static_cast<SmEdge*>(c));
        }
        return SM_SUCCESS; // observation fixture only; no Ledger and no publication
    }
    void dump() const {
        for(size_t i=0;i<count;++i) {
            const auto& r=rows[i];
            std::fprintf(stderr,"subdivision event=%zu op=%ld type=%ld caller=%p a=%p b=%p c=%p\n",i+1,r.operation,r.type,
                static_cast<void*>(r.caller),static_cast<void*>(r.a),static_cast<void*>(r.b),static_cast<void*>(r.c));
        }
        std::fprintf(stderr,"OBSERVATION_ONLY events=%zu overflow=%u edge_pre=%u split_receipt=%u acceptance=false\n",
            count,unsigned(overflow),unsigned(started),unsigned(receipt));
    }
};
struct Attachment {
    SmContext& context;
    explicit Attachment(SmContext& c,Observer& observer):context(c) { context.SetUserNotifyCallback(&observer); }
    ~Attachment() { context.SetUserNotifyCallback(nullptr); }
};
}
int main() {
    try {
        SmApiCreateContext(); auto& context=*SmApiGetOrCreateContext();
        if(context.GetUserNotifyCallback() || context.GetSysNotifyCallback() || context.GetAttributeCallbacks()) return 2;
        SmBrep* raw=nullptr;
        if(SmApiCreateCylinder(SmVector3d(0,0,0),2,3,raw)!=SM_SUCCESS || !raw) return 2;
        std::unique_ptr<SmBrep> source(raw); prepare_owned_affine_source(*source);
        const double identity[16]={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
        ifclite_smlib_affine_certificate certificate{};
        auto target=copy_affine_rational(source.get(),identity,certificate);
        auto observer=std::make_unique<Observer>();
        SmPolyBrep* polygon=nullptr; SmTessellationReport report;
        SmTessellationParams params; params.dChordHeightTol=.001;
        params.dCurveAngleTolDeg=5; params.dSurfaceAngleTolDeg=5;
        SmStatus status;
        {
            Attachment attachment(context,*observer);
            status=SmApiTessellate(target.get(),polygon,params,FALSE,nullptr,&report);
        }
        observer->dump();
        std::fprintf(stderr,"OBSERVATION_ONLY sdk_status=%ld reported_failures=%lu acceptance=false\n",
            long(status),static_cast<unsigned long>(report.failures.GetSize()));
        delete polygon;
        return !observer->overflow && observer->started && observer->receipt?0:3;
    } catch(const AdapterFailure& e) { std::fprintf(stderr,"OBSERVATION_REFUSED %s\n",e.message); }
    catch(const KernelDomainTainted& e) { std::fprintf(stderr,"OBSERVATION_TAINT %s\n",e.message.c_str()); }
    catch(const std::exception& e) { std::fprintf(stderr,"OBSERVATION_EXCEPTION %s\n",e.what()); }
    return 2;
}
