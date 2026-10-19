// SPDX-License-Identifier: MPL-2.0
#include "face_extraction.hpp"
#include "context_metadata.hpp"
#include "copy.hpp"
#include "representation_seal.hpp"
#include "ifclite_smlib.h"
#include "sweep.hpp"
#include <SmFace.h>
#include <SmFaceuse.h>
#include <SmMerge.h>
#include <SmObject.h>
#include <SmShell.h>
#include <new>
namespace face_lineage {
namespace {
void require(bool value,const char* message) {
    if(!value) throw SweepFailure{IFCLITE_SMLIB_UNSUPPORTED,message};
}
SmFace* mapped_face(SmMerge& relations,SmFace* source,SmBrep& target) {
    auto* mapped=relations.GetTopologyIntersector().GetBrepMate(source);
    SmTArray<SmFace*> live; target.GetFaces(live);
    SmFace* result=nullptr; unsigned hits=0;
    for(auto* face:live) if(face==mapped) { result=face; ++hits; }
    require(hits==1 && result && result->GetBrep()==&target,"extraction mate is not exactly one actual live target face");
    return result;
}
}
std::vector<FaceTransfer> checked_extract_faces(SmBrep& source,SmBrep& target,
    SmMerge& relations,SmFace* const* selected,uint32_t count,Ledger& ledger) {
    if(kernel_domain_is_tainted()) throw KernelDomainTainted{"face extraction refused after terminal isolation failure"};
    require(&source!=&target && source.GetContext() && source.GetContext()==target.GetContext(),
        "extraction requires separate owned operands in one actual SDK context");
    auto& topology=relations.GetTopologyIntersector();
    require(topology.GetPrimaryBrep()==&target && topology.GetOtherBrep()==&source,
        "extraction relation owner does not bind the actual ordered operands");
    ledger.verify_inventory(source); ledger.verify_inventory(target);
    require((selected || !count) && count<=source.GetNumFaces(),"extraction selection exceeds actual source inventory");
    SmTArray<SmFace*> source_faces,target_before;
    source.GetFaces(source_faces); target.GetFaces(target_before);
    // verify_inventory bounds each inventory to the ledger's <=65536-node cap.
    // Allocate bounded snapshots BEFORE mutation; the callback does not grow.
    std::vector<Identity> admitted;
    std::vector<FaceTransfer> transfers;
    try {
        admitted.reserve(size_t(count)+target_before.GetSize()); transfers.reserve(count);
        for(auto* face:target_before) admitted.push_back(ledger.identity(face));
        for(uint32_t i=0;i<count;++i) {
            unsigned hits=0; for(auto* face:source_faces) hits+=face==selected[i];
            require(hits==1 && selected[i],"missing/foreign source face in extraction selection");
            for(uint32_t j=0;j<i;++j) require(selected[j]!=selected[i],"duplicate extraction selection");
            auto* use=selected[i]->GetUpwardFaceuse();
            require(use && use->GetMate() && use->GetFace()==selected[i] &&
                use->GetMate()->GetFace()==selected[i] && use->GetShell() && use->GetMate()->GetShell() &&
                use->GetShell()->GetRegion() && use->GetMate()->GetShell()->GetRegion() && selected[i]->GetSurface(),
                "selected actual source face lacks two attached uses or supporting surface");
            const auto id=ledger.identity(selected[i]); admitted.push_back(id); transfers.push_back({id,{}});
        }
    } catch(const std::bad_alloc&) {
        throw SweepFailure{IFCLITE_SMLIB_RESOURCE_LIMIT,"bounded extraction snapshot allocation failed"};
    }
    auto& context=*const_cast<SmContext*>(source.GetContext());
    raw_context::Restore preserve_context(&context);
    SmTemporaryChangeValue<SmBoolean> editable(target.m_bEditingEnabled,TRUE);
    SmTemporaryChangeValue<SmBoolean> boolean(context.GetDoingBooleanRef(),TRUE);
    Scope phase(ledger,context,&source);
    RepresentationSeal source_seal(ledger,source);
    try {
        for(uint32_t i=0;i<count;++i) {
            SmRegion* old_region=nullptr; SmRegion* new_region=nullptr;
            // Do not call CopyFaces: its SE(MakeFaceuse(...)) loses failure.
            // The optional new-face array is NOT completeness authority: the
            // already-mated SDK branch returns no new face but emits a copy.
            const auto status=relations.MakeFaceuse(selected[i]->GetUpwardFaceuse(),old_region,new_region);
            if(status!=SM_SUCCESS) throw SweepFailure{IFCLITE_SMLIB_KERNEL_ERROR,"checked SDK face extraction failed"};
            ledger.check(); ledger.verify_inventory(source); ledger.verify_inventory(target);
            source_seal.verify();
            auto* copied=mapped_face(relations,selected[i],target);
            require(ledger.identity(selected[i])==transfers[i].source &&
                ledger.descends_from(ledger.identity(copied),transfers[i].source),
                "face extraction changed source identity or lost actual copied ancestry");
        }
        SmTArray<SmFace*> final_faces; target.GetFaces(final_faces);
        for(auto* face:final_faces) {
            bool accounted=false; const auto id=ledger.identity(face);
            for(auto input:admitted) if(ledger.descends_from(id,input)) { accounted=true; break; }
            require(accounted,"extraction introduced a face outside selected or pre-existing target ancestry");
        }
        for(uint32_t i=0;i<count;++i) {
            transfers[i].output=ledger.identity(mapped_face(relations,selected[i],target));
            require(ledger.descends_from(transfers[i].output,transfers[i].source),"final extraction relation lost a selected fragment");
        }
        phase.finish(); ledger.check(); return transfers;
    } catch(...) {
        // Source/target/operator ownership belongs to the enclosing isolation.
        // Failure can leave unlinked allocations or stale relation maps.
        rethrow_tainted_kernel_domain("checked face extraction");
    }
}
}
