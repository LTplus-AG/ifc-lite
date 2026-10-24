// SPDX-License-Identifier: MPL-2.0
#include "source_construction.hpp"
#include "failure.hpp"
#include <SmFace.h>
namespace face_lineage {
namespace {
void require(bool value,const char* why) { if(!value) throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,why}; }
}
void SourceConstruction::begin_cap(uint32_t curves) {
    require(!failed && !finished && body && !cap_phase.active && curves && curves<=128,
        "source cap requires one bounded construction operation");
    cap_phase={}; cap_phase.active=true; cap_phase.first_birth=birth_count; cap_phase.limit=curves;
}
bool SourceConstruction::cap_split(SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) noexcept {
    if(op!=SM_NO_SPLIT_IN_BREP || !a || a->GetType()!=SmFace_TYPE) return false;
    // CreateFacesWithCurves builds a covering plane, closes each input loop by
    // splitting it, then deletes the outside/holes (SmBrep.cpp:3484-3694).
    // This receipt authorizes only those still-unissued physical generations.
    if(failed || !cap_phase.active || caller!=body || a!=b || !c || a==c || c->GetType()!=SmFace_TYPE ||
        static_cast<SmFace*>(a)->GetBrep()!=body || static_cast<SmFace*>(c)->GetBrep()!=body ||
        cap_phase.count>=cap_phase.limit) {
        refuse("unowned-cap-split",op,caller,a,b,c); return true;
    }
    Birth *parent=nullptr,*child=nullptr;
    for(uint32_t i=cap_phase.first_birth;i<birth_count;++i) if(births[i].live) {
        if(births[i].face==a) parent=&births[i];
        if(births[i].face==c) child=&births[i];
    }
    if(!parent || !child || parent->generation==child->generation) {
        refuse("cap-split-generation",op,caller,a,b,c); return true;
    }
    // Only the first actual face constructor of THIS call is the covering
    // plane. Every other parent needs a previously observed split edge.
    bool rooted=parent->generation==uint64_t(cap_phase.first_birth)+1;
    for(uint32_t i=0;i<cap_phase.count;++i) {
        rooted|=cap_phase.splits[i].child==parent->generation;
        if(cap_phase.splits[i].child==child->generation) {
            refuse("repeated-cap-child",op,caller,a,b,c); return true;
        }
    }
    for(const auto& role:roles) if(role.face==a || role.face==c) {
        refuse("issued-cap-split",op,caller,a,b,c); return true;
    }
    if(!rooted || child->generation<=parent->generation) {
        refuse("unrooted-cap-split",op,caller,a,b,c); return true;
    }
    cap_phase.splits[cap_phase.count++]={parent->generation,child->generation};
    return true;
}
void SourceConstruction::finish_cap(const SmTArray<SmFace*>& output) {
    require(!failed && cap_phase.active && output.GetSize()==1,
        "source cap requires one checked connected output");
    // One covering plane plus one new physical face per real split. Missing
    // receipts, stray births, surviving outside regions and address reuse fail.
    require(cap_phase.count>0 && birth_count-cap_phase.first_birth==cap_phase.count+1,
        "source cap requires complete split receipts");
    unsigned survivors=0;
    for(uint32_t i=cap_phase.first_birth;i<birth_count;++i) {
        const auto& birth=births[i];
        if(!birth.live) continue;
        bool child=false;
        for(uint32_t j=0;j<cap_phase.count;++j) child|=cap_phase.splits[j].child==birth.generation;
        require(child && birth.face==output[0] && output[0]->GetBrep()==body,
            "source cap output must be the live observed descendant");
        ++survivors;
    }
    require(survivors==1,"source cap must retire all temporary outside faces");
    cap_phase.active=false;
}
}
