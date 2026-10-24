// SPDX-License-Identifier: MPL-2.0
#include "source_construction.hpp"
#include "context_metadata.hpp"
#include "failure.hpp"
#include "copy.hpp"
#include "affine.hpp"
#include "affine_rational.hpp"
#include <SmFace.h>
#include <SmCurve.h>
#include <SmBSplineCurve.h>
#include <SmSurfOfExtrusion.h>
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
#include <execinfo.h>
#include <cstdio>
#include <unistd.h>
#endif
namespace face_lineage {
namespace {
void require(bool value,const char* why) { if(!value) throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,why}; }
void checked(SmStatus value) { require(value==SM_SUCCESS,"source constructor SDK operation failed"); }
}
SourceConstruction::SourceConstruction(SmContext& c):context(c) {
    require(!c.GetUserNotifyCallback() && !c.GetSysNotifyCallback() && !c.GetAttributeCallbacks(),
        "source constructor requires its own callback domain");
    roles.reserve(130); context.SetUserNotifyCallback(this);
}
SourceConstruction::~SourceConstruction() {
    if(context.GetUserNotifyCallback()==this) context.SetUserNotifyCallback(nullptr);
}
void SourceConstruction::refuse(const char* why,SmNotifyOperation op,SmObject* caller,
    SmObject* a,SmObject* b,SmObject* c) noexcept {
    if(failed) return;
    failed=true;
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
    // First real constructor failure only. Slots are diagnostic addresses,
    // never dereferenced or used as provenance; no event replay or recovery.
    std::fprintf(stderr,"source construction first_refusal=%s event=%u op=%ld type=%ld caller=%p a=%p b=%p c=%p births=%u roles=%zu\n",
        why,event_count,long(op),caller?long(caller->GetType()):0,static_cast<void*>(caller),
        static_cast<void*>(a),static_cast<void*>(b),static_cast<void*>(c),birth_count,roles.size());
    void* frames[32]; const int count=::backtrace(frames,32);
    if(count>0) ::backtrace_symbols_fd(frames,count,STDERR_FILENO);
#else
    (void)why; (void)op; (void)caller; (void)a; (void)b; (void)c;
#endif
}
SmStatus SourceConstruction::Execute(SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) noexcept {
    if(++event_count>131072) refuse("event-bound",op,caller,a,b,c);
    if(cap_split(op,caller,a,b,c)) return SM_SUCCESS;
    if(op==SM_NO_SPLIT_IN_BREP || op==SM_NO_MERGE_IN_BREP) {
        for(auto* object:{a,b,c}) if(object && object->GetType()==SmFace_TYPE) refuse("face-split-or-merge",op,caller,a,b,c);
    }
    if(!caller || caller->GetType()!=SmFace_TYPE) return SM_SUCCESS;
    if(op==SM_NO_CONSTRUCTION) {
        if(birth_count==births.size()) { refuse("birth-bound",op,caller,a,b,c);return SM_SUCCESS; }
        for(uint32_t i=0;i<birth_count;++i) if(births[i].face==caller && births[i].live) refuse("live-address-reconstruction",op,caller,a,b,c);
        births[birth_count]={caller,uint64_t(birth_count)+1,true};++birth_count;
    } else if(op==SM_NO_DESTRUCTION) {
        bool found=false;
        for(uint32_t i=0;i<birth_count;++i) if(births[i].face==caller && births[i].live) {
            births[i].live=false;found=true;
            for(const auto& role:roles) if(role.face==caller && role.birth==births[i].generation) refuse("issued-face-destruction",op,caller,a,b,c);
        }
        if(!found) refuse("unobserved-face-destruction",op,caller,a,b,c);
    } else if(op==SM_NO_COPY || op==SM_NO_SPLIT || op==SM_NO_MERGE) {
        // No constructor role can survive an unproved face substitution.
        refuse("face-substitution",op,caller,a,b,c);
    }
    return SM_SUCCESS; // SDK ignores statuses; every phase checks the latch.
}
void SourceConstruction::add(SmFace* face,SourceRole role,uint32_t ordinal) {
    require(!failed,"source constructor face output invalid: callback refused");
    require(face,"source constructor face output invalid: null SDK output");
    require(face->GetBrep()==body,"source constructor face output invalid: foreign BRep owner");
    require(roles.size()<130,"source constructor face output invalid: role bound");
    uint64_t birth=0;unsigned hits=0;
    for(uint32_t i=0;i<birth_count;++i) if(births[i].face==face && births[i].live) { birth=births[i].generation;++hits; }
    require(hits==1,"source face requires its observed original construction generation");
    for(const auto& old:roles) require(old.face!=face,"source constructor returned duplicate face");
    roles.push_back({face,birth,role,ordinal});
}
void SourceConstruction::cap(SmTArray<SmCurve*>& curves,SourceRole role) {
    SmTArray<SmFace*> output;
    begin_cap(uint32_t(curves.GetSize()));
    try {
        checked(body->CreatePlanarFacesWith3DCurves(body->GetInfiniteRegion(),curves,body->GetTolerance(),output));
        finish_cap(output);
    } catch(...) { cap_phase.active=false; throw; }
    // Current source format is one outer region with holes. Disconnected caps
    // need an explicit source-region correspondence, not an array-order label.
    require(output.GetSize()==1,"source constructor requires one connected cap region");
    add(output[0],role,0);
}
std::unique_ptr<SmBrep> SourceConstruction::construct(const SmTArray<SmCurve*>& input,const SmVector3d& direction,double depth) {
    require(!body && !finished && input.GetSize()>0 && input.GetSize()<=128,"source constructor one-shot bounded input");
    auto result=raw_context::construct_brep(&context); body=result.get();body->m_bEditingEnabled=TRUE;
    try {
        SmTArray<SmCurve*> start,end;
        SmAxis2Placement translation;
        checked(translation.SetCanonical(SmPoint3d(0,0,0),SmVector3d(1,0,0),SmVector3d(0,1,0)));
        translation.Translate(depth*direction);
        // Each side is issued at the actual face constructor call for that
        // encoded construction segment. No final-face ordering or geometric matching.
        for(ULONG i=0;i<input.GetSize();++i) {
            SmCurve *curve=nullptr,*base=nullptr,*top=nullptr;
            checked(input[i]->Copy(context,curve));checked(input[i]->Copy(context,base));checked(input[i]->Copy(context,top));
            require(curve && base && top && curve->IsKindOf(SmBSplineCurve_TYPE),"source sweep rational curve construction");
            start.Add(base);end.Add(top);checked(top->Transform(translation));
            SmSurfOfExtrusion* surface=nullptr;
            checked(SmSurfOfExtrusion::CreateCanonical(context,static_cast<SmBSplineCurve*>(curve),direction,surface));
            require(surface,"source sweep surface construction");
            checked(surface->AdjustSTEPUVDomain(SmExtent2d(0,0,1,depth)));
            auto rational=copy_initial_surface(*body,*surface,*this);delete surface;
            const auto domain=rational->GetNaturalUVDomain();
            SmFace* face=nullptr;
            checked(body->CreateFaceFromSurface(rational.release(),domain,face));
            add(face,SourceRole::SweptSegment,uint32_t(i));
        }
        cap(start,SourceRole::StartCap);cap(end,SourceRole::EndCap);
        checked(body->StitchAndOrient());body->m_bEditingEnabled=FALSE;
        verify();
        for(const auto& role:roles) {
            double ms=0,xs=0,me=0,xe=0,mv=0,xv=0;
            checked(role.face->CreateUVTrimCurves(FALSE,nullptr,nullptr,ms,xs,me,xe,mv,xv));
        }
        // Initial construction is still observed. This checked overload keeps
        // every existing normalization and numerical observer guard intact.
        prepare_constructed_affine_source(*body,*this);
        verify();return result;
    } catch(...) { result.release();rethrow_tainted_kernel_domain("source role construction"); }
}
void SourceConstruction::verify() const {
    require(!failed && !finished && context.GetUserNotifyCallback()==this &&
        !context.GetSysNotifyCallback() && !context.GetAttributeCallbacks(),"source construction observation failed");
    require(body && body->GetNumFaces()==roles.size(),"source construction complete inventory");
    SmTArray<SmFace*> actual;body->GetFaces(actual);
    require(actual.GetSize()==roles.size(),"source construction inventory changed");
    for(const auto& role:roles) {
        unsigned live=0,hits=0;
        for(uint32_t i=0;i<birth_count;++i) live+=births[i].face==role.face && births[i].generation==role.birth && births[i].live;
        for(auto* face:actual) hits+=face==role.face;
        require(live==1 && hits==1 && role.face->GetBrep()==body,"source constructor lost physical face generation");
    }
}
void SourceConstruction::validate_initial(const SmBrep& source) const {
    require(&source==body,"foreign initial normalization source");verify();
}
std::vector<ConstructedFace> SourceConstruction::finish(SmBrep& source) {
    validate_initial(source);finished=true;context.SetUserNotifyCallback(nullptr);return std::move(roles);
}
}
