// SPDX-License-Identifier: MPL-2.0
#include "face_extraction.hpp"
#include "context_metadata.hpp"
#include "copy.hpp"
#include "representation_seal.hpp"
#include "ifclite_smlib.h"
#include "sweep.hpp"
#include <SmFace.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmVertexuse.h>
#include <SmBSplineCurve.h>
#include <cstring>
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
bool bits(double a,double b) { return std::memcmp(&a,&b,sizeof(a))==0; }
SmEdgeuse* canonical_uv_owner(SmEdgeuse* use,SmFace* face,SmBrep& body) {
    auto* mate=use?use->GetMate():nullptr;
    require(use && mate && mate!=use && mate->GetMate()==use &&
        use->GetFace()==face && mate->GetFace()==face && use->GetBrep()==&body && mate->GetBrep()==&body &&
        use->GetEdge() && mate->GetEdge()==use->GetEdge(),"UV attachment requires exact reciprocal face/brep/edge mates");
    const auto orientation=use->GetOrientation();
    require((orientation==SM_OT_SAME && mate->GetOrientation()==SM_OT_OPPOSITE) ||
        (orientation==SM_OT_OPPOSITE && mate->GetOrientation()==SM_OT_SAME),"UV attachment requires complementary parameter orientations");
    // Pinned SmEdgeuse::SetUVTrimCurve stores on the SAME member, even
    // when invoked through its OPPOSITE mate (SmEdgeuse.cpp:4547-4570).
    return orientation==SM_OT_SAME?use:mate;
}
void verify_uv_attachment(SmEdgeuse* use,SmFace* face,SmBrep& body,SmBSplineCurve* raw) {
    auto* expected=canonical_uv_owner(use,face,body);
    auto* other=expected->GetMate(); SmEdgeuse* reported=nullptr;
    require(raw && use->GetUVTrimCurve(&reported)==raw && reported==expected && raw->GetOwner()==expected &&
        expected->GetUVTrimCurvePointer()==raw && other->GetUVTrimCurvePointer()==nullptr,
        "UV attachment does not match exact SDK-selected SAME owner/raw pointer/backlink");
}

struct TrimTransfer {
    SmFace* face;
    SmEdgeuse* use;
    SmBSplineCurve* original;
    std::unique_ptr<SmBSplineCurve> copy;
};
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
    std::vector<TrimTransfer> trims; std::vector<SmEdgeuse*> matched;
    try { trims.reserve(8192); matched.reserve(8192); }
    catch(const std::bad_alloc&) { throw SweepFailure{IFCLITE_SMLIB_RESOURCE_LIMIT,"bounded UV transfer allocation failed before mutation"}; }
    uint64_t copy_words=0;
    try {
        for(uint32_t i=0;i<count;++i) {
            SmTArray<SmEdgeuse*> uses; selected[i]->GetUpwardEdgeuses(uses);
            require(uses.GetSize() && uses.GetSize()<=8192-trims.size(),"bounded complete selected-face trim inventory");
            for(auto* use:uses) {
                SmEdgeuse* owner=nullptr; auto* trim=use->GetUVTrimCurve(&owner);
                require(trim && owner && trim->GetDim()==2 && !use->GetDropCurveFail(),
                    "source extraction requires genuine complete owned UV trims");
                verify_uv_attachment(use,selected[i],source,trim);
                for(const auto& prior:trims) require(prior.use!=use,"duplicate source UV-use inventory");
                ULONG coefficients=0; double* values=nullptr;
                require(trim->GetControlPointsPointer(coefficients,values)==SM_SUCCESS && coefficients && values,
                    "missing actual source UV coefficients before copy");
                copy_words+=4*uint64_t(coefficients)+trim->GetNumberNaturalKnots();
                if(copy_words>1048576) throw SweepFailure{IFCLITE_SMLIB_RESOURCE_LIMIT,"bounded aggregate UV copy coefficient budget"};
                SmCurve* raw=nullptr; const auto status=trim->Copy(context,raw);
                // Capacity was bounded/reserved before this SDK call. Keep
                // every provisional pointer available for abandonment on fault.
                trims.push_back({selected[i],use,trim,std::unique_ptr<SmBSplineCurve>(static_cast<SmBSplineCurve*>(raw))});
                if(status!=SM_SUCCESS || !raw) throw SweepFailure{IFCLITE_SMLIB_KERNEL_ERROR,"actual source UV trim copy failed"};
                ledger.check(); source_seal.require_exact_curve_copy(trim,raw);
            }
        }
        source_seal.verify();
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
            // MakeFaceuse defaults bCalculateTrims=FALSE. Preserve actual
            // source UV representation now; never let a later read heal it.
            source_seal.require_exact_surface_copy(selected[i]->GetSurface(),copied->GetSurface());
            const auto from_domain=selected[i]->GetUVDomain(),to_domain=copied->GetUVDomain();
            require(bits(from_domain.GetUMin(),to_domain.GetUMin()) && bits(from_domain.GetUMax(),to_domain.GetUMax()) &&
                bits(from_domain.GetVMin(),to_domain.GetVMin()) && bits(from_domain.GetVMax(),to_domain.GetVMax()),
                "extracted face changed exact source parameter domain");
            SmTArray<SmEdgeuse*> uses; copied->GetUpwardEdgeuses(uses);
            uint32_t expected=0; for(const auto& trim:trims) expected+=trim.face==selected[i];
            require(uses.GetSize()==expected,"extracted UV incidence inventory is incomplete");
            matched.clear();
            for(auto& trim:trims) if(trim.face==selected[i]) {
                auto* edge=topology.GetBrepMate(trim.use->GetEdge());
                SmEdgeuse* actual=nullptr; unsigned hits=0;
                for(auto* use:uses) if(use->GetEdge()==edge && use->GetOrientation()==trim.use->GetOrientation()) { actual=use; ++hits; }
                require(hits==1 && actual && actual->GetFace()==copied && actual->GetMate() &&
                    actual->GetVertexuse() && trim.use->GetVertexuse() && trim.use->GetMate() &&
                    actual->GetMate()->GetVertexuse() && trim.use->GetMate()->GetVertexuse() &&
                    topology.GetBrepMate(trim.use->GetVertexuse()->GetVertex())==actual->GetVertexuse()->GetVertex() &&
                    topology.GetBrepMate(trim.use->GetMate()->GetVertexuse()->GetVertex())==actual->GetMate()->GetVertexuse()->GetVertex(),
                    "missing or ambiguous exact extracted edge/vertex/use incidence");
                for(auto* prior:matched) require(prior!=actual,"duplicate extracted UV-use correspondence");
                matched.push_back(actual);
                SmEdgeuse* existing_owner=nullptr;
                auto* existing=actual->GetUVTrimCurve(&existing_owner);
                require(!actual->GetDropCurveFail(),"failed extracted UV history cannot be replaced by a copied trim");
                if(existing) {
                    require(existing_owner==canonical_uv_owner(actual,copied,target),"existing extracted trim has wrong canonical owner");
                    verify_uv_attachment(actual,copied,target,existing);
                    source_seal.require_exact_curve_copy(trim.original,existing);
                }
                else {
                    canonical_uv_owner(actual,copied,target); // Validate exact expected member before attachment.
                    auto* raw=trim.copy.get(); actual->SetUVTrimCurve(raw,0.,FALSE); ledger.check();
                    verify_uv_attachment(actual,copied,target,raw);
                    trim.copy.release();
                }
            }
            require(matched.size()==uses.GetSize(),"extracted UV correspondence is not exhaustive");
            source_seal.verify();
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
        // A complete post-transfer graph must support the normal exact seal;
        // no missing-trim seal mode or general numerical-edit exemption.
        if(target.GetNumFaces()) { RepresentationSeal target_seal(ledger,target); target_seal.verify(); }
        else ledger.verify_inventory(target); // Actual semantic empty, no invented boundary seal.
        phase.finish(); ledger.check(); return transfers;
    } catch(...) {
        // Source/target/operator ownership belongs to the enclosing isolation.
        // Failure can leave unlinked allocations or stale relation maps.
        for(auto& trim:trims) trim.copy.release();
        rethrow_tainted_kernel_domain("checked face extraction");
    }
}
}
