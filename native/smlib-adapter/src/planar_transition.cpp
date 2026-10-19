// SPDX-License-Identifier: MPL-2.0
#include "planar_transition_detail.hpp"
#include "copy.hpp"
#include "context_metadata.hpp"
#include <cstdio>
namespace face_lineage {
using namespace planar_detail;
PlanarTransition::~PlanarTransition() {
    if(kernel_domain_is_tainted()) {
        line3.release(); line2.release();
        for(auto& slot:slots) slot.retained.release();
    }
}
TransitionReceipt PlanarTransition::roundtrip(Ledger& ledger,SmBrep& source,SmBrep& working,SmFace& face) {
    if(kernel_domain_is_tainted()) throw KernelDomainTainted{"transition refused after isolation failure"};
    require(!ledger.active_transition && !ledger.numerical.source && ledger.frame_count &&
        (!ledger.completed_transition || ledger.completed_transition->consumed),"unconsumed/nested transition");
    require(source.GetContext()==working.GetContext() && working.GetContext(),"transition context mismatch");
    // A prior owned transition's terminal seal remains the authority for this
    // actual live target between calls. Never adopt a silent edit as a fresh pre-state.
    if(ledger.completed_transition && &ledger.completed_transition->working==&working) {
        ledger.verify_inventory(working); ledger.completed_transition->post_seal->verify();
    }
    ledger.completed_transition.reset(); // consumed predecessor; bounded one retained plan
    auto& context=*const_cast<SmContext*>(working.GetContext());
    raw_context::Restore preserve(&context); Scope phase(ledger,context,&source);
    std::unique_ptr<PlanarTransition> plan;
    try { plan.reset(new PlanarTransition(ledger,source,working,face)); }
    catch(const std::bad_alloc&) { throw SweepFailure{IFCLITE_SMLIB_RESOURCE_LIMIT,"bounded planar transition allocation"}; }
    const auto editing=working.m_bEditingEnabled;
    try {
        ledger.active_transition=plan.get(); plan->prepare();
        working.m_bEditingEnabled=TRUE;
        plan->insert(); plan->check_children();
        ledger.active_transition=nullptr; plan->numeric_check(true); ledger.active_transition=plan.get();
        plan->erase(); plan->restore(); working.m_bEditingEnabled=editing;
        plan->discharge();
        ledger.active_transition=nullptr; plan->numeric_check(false);
        plan->post_seal->verify(); plan->source_seal->verify();
        phase.finish(); ledger.check();
        plan->source_seal.reset(); plan->pre_seal.reset(); // only the new physical terminal seal survives
        const auto result=plan->receipt; ledger.completed_transition=std::move(plan); return result;
    } catch(...) {
        ledger.active_transition=nullptr; working.m_bEditingEnabled=editing;
        std::fprintf(stderr,"planar transition refused stage=%u operation=%llu diagonal_generation=%llu\n",
            unsigned(plan->step),static_cast<unsigned long long>(plan->receipt.operation.sequence),
            static_cast<unsigned long long>(plan->diagonal_birth.sequence));
        // Uncertain graph ownership/lifetime is never cleaned up speculatively.
        plan->line3.release(); plan->line2.release(); for(auto& slot:plan->slots) slot.retained.release();
        rethrow_tainted_kernel_domain("fixed rectangular planar transition");
    }
}
void PlanarTransition::insert() {
    step=Step::Classify; SmVertexuse* vertexuses[2]{};
    for(unsigned i=0;i<2;++i) {
        SmBoolean possible=FALSE; SmClassifyProblem problem=SM_CP_NONE;
        const auto status=face.FindVertexSector(corners[i?3:0],*curve3,curve2,i?1.:0.,i?0.:1.,
            i?SM_OT_OPPOSITE:SM_OT_SAME,working.GetTolerance(),TRUE,vertexuses[i],possible,problem);
        ledger.check(); checked(status,"checked diagonal sector classification");
        require(!possible && problem==SM_CP_NONE && vertexuses[i] && vertexuses[i]->IsEdgeVertexuse() &&
            vertexuses[i]->GetVertex()==corners[i?3:0] && vertexuses[i]->GetBrep()==&working &&
            vertexuses[i]->GetFaceuse()==face.GetUpwardFaceuse(),"uncertain/wrong diagonal vertex sector");
        auto* use=vertexuses[i]->GetEdgeuse(); bool actual=false;
        for(const auto& slot:slots) actual|=slot.use==use;
        require(actual,"sector must be an actual preissued upward boundary use");
    }
    require(vertexuses[0]!=vertexuses[1],"same-vertex unsupported diagonal branch");
    source_seal->verify(); // preseal editing flag is intentionally changed only inside transaction
    step=Step::Insert; SmEdge* edge=nullptr; SmFace* fragment=nullptr; SmLoop* loop=nullptr;
    line3.release(); line2.release(); // Consumed by public WithVU, including uncertain failures.
    const auto status=working.MakeEdgeInFaceWithVU(&face,vertexuses[0],vertexuses[1],curve3,curve2,
        SmExtent1d(0,1),SM_OT_SAME,working.GetTolerance(),edge,loop,fragment);
    ledger.check(); checked(status,"checked public diagonal insertion");
    require(edge && edge==diagonal && fragment && fragment==child && loop && loop->GetBrep()==&working &&
        split_events==1 && cut_copy && edge_geometry==1 && curve_owner==1 && surface_owner==1 && add_events==1 &&
        face_pre[0]==1,"missing actual diagonal/fragment/split receipts");
    auto* binding=ledger.binding(diagonal,false); auto* child_binding=ledger.binding(child,false);
    require(binding && child_binding && binding->alive && !binding->retired,"missing live diagonal generation");
    require(binding->current==diagonal_birth && child_birth.sequence,
        "actual constructor-time diagonal/child generation receipts changed");
    receipt.children[0]=ledger.identity(&face); receipt.children[1]=ledger.identity(child);
    require(receipt.children[0]!=receipt.children[1] && receipt.children[0]!=receipt.parent &&
        receipt.children[1]!=receipt.parent && ledger.descends_from(receipt.children[0],receipt.parent) &&
        ledger.descends_from(receipt.children[1],receipt.parent),"split ancestry receipts do not match issued parent");
    face_pre[0]=face_pre[1]=0;
}
void PlanarTransition::erase() {
    check_children(); source_seal->verify(); step=Step::Delete;
    const auto status=working.DeleteEdge(diagonal,support); ledger.check(); checked(status,"checked exact diagonal deletion");
    require(edge_pre==1 && merge_events==1 && face_pre[0]==2 && face_pre[1]==2 && brep_pre==1 && remove_events==1,
        "incomplete exact deletion/UV invalidation event receipts");
    require(destroyed_curve_count==7,"missing planned numerical destruction receipts");
    for(unsigned i=0;i<born_count;++i) require(born[i].destroyed,"missing planned temporary topology/support destruction");
    receipt.merged=ledger.identity(&face);
    require(ledger.descends_from(receipt.merged,receipt.children[0]) && ledger.descends_from(receipt.merged,receipt.children[1]) &&
        receipt.merged!=receipt.children[0] && receipt.merged!=receipt.children[1],"new merged physical generation missing");
    diagonal=nullptr; child=nullptr; child_surface=nullptr; curve3=nullptr; curve2=nullptr; cut_copy=nullptr;
    step=Step::Restore;
}
void PlanarTransition::restore() {
    require(face.GetSurface()==support && support->GetOwner()==&face && face.GetBrep()==&working &&
        working.GetNumFaces()==pre_faces && working.GetNumEdges()==pre_edges && working.GetNumVertices()==pre_vertices,
        "post-deletion retained support/inventory mismatch");
    restore_heads();
    SmTArray<SmEdgeuse*> actual; face.GetUpwardEdgeuses(actual);
    require(actual.GetSize()==slots.size(),"missing restored rectangle boundary");
    for(auto& slot:slots) {
        unsigned hits=0; for(auto* use:actual) hits+=use==slot.use;
        require(hits==1 && !slot.use->GetUVTrimCurve() && !slot.use->GetDropCurveFail() && slot.retained,
            "retained UV restoration requires exact unique empty original boundary slot");
        auto* entry=ledger.binding(slot.retained.get(),false);
        require(entry && entry->alive && !entry->retired && entry->current==slot.birth &&
            entry->owned_transition==receipt.operation && entry->birth_frame==frame,"stale/replaced retained UV generation");
        auto* canonical=owner(slot.use,&face,working,nullptr);
        slot.attached=slot.retained.get();
        slot.use->SetUVTrimCurve(slot.attached,0.,FALSE);
        owner(slot.use,&face,working,slot.attached);
        require(slot.attached->GetOwner()==canonical,"SDK-selected canonical trim attachment differs");
        slot.retained.release(); ledger.check();
    }
}
void PlanarTransition::consume(Ledger& ledger,const TransitionReceipt& receipt,SmBrep& working) {
    ledger.check(); require(ledger.completed_transition!=nullptr,"unissued transition receipt");
    ledger.completed_transition->validate_receipt(receipt,working);
    ledger.completed_transition->consumed=true;
}
void PlanarTransition::validate_receipt(const TransitionReceipt& value,SmBrep& target) {
    require(!consumed && discharged && &target==&working && ledger.frame_count+1==frame &&
        ledger.frames[frame-2] && ledger.frames[frame-2]->serial==parent_frame_serial &&
        value.operation==receipt.operation && value.revision==receipt.revision && value.parent==receipt.parent &&
        value.children[0]==receipt.children[0] && value.children[1]==receipt.children[1] && value.merged==receipt.merged,
        "foreign/reused/stale transition receipt");
    require(ledger.identity(&face)==receipt.merged,"transition physical face generation changed");
    post_seal->verify(); ledger.verify_inventory(working);
}
}
