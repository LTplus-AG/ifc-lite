// SPDX-License-Identifier: MPL-2.0
// #7955: mutate actual SDK state without a notify and demand terminal refusal.
#include "affine_transition.hpp"
#include "owned_lineage_access.hpp"
#include "copy.hpp"
#include "failure.hpp"
#include <SmCopyBrepMap.h>
#include <SmBSplineSurface.h>
#include <SmFace.h>
#include <cstring>
#include <stdexcept>
namespace face_lineage {
struct AffineTransitionTestAccess {
    static void exercise(Ledger& ledger,SmBrep& source,SmBrep& working,SmBrep& sibling,
                         const SmCopyBrepMap& map,const char* mode) {
        AffineTransition plan(ledger,source,working,map);
        SmAxis2Placement placement;
        plan.convert(); plan.place(placement,nullptr);
        const SmVector3d scale(2,3,4);
        if(std::strcmp(mode,"receipt")==0) {
            // Execute the genuine prescribed SDK operation with notifications
            // suppressed, then restore the slot. Numerical equality alone must
            // not authenticate the missing semantic observation interval.
            plan.prepare_place(placement,&scale);
            auto& context=*const_cast<SmContext*>(working.GetContext());
            auto* observer=context.GetUserNotifyCallback(); context.SetUserNotifyCallback(nullptr);
            const auto status=working.Transform(placement,&scale,FALSE);
            context.SetUserNotifyCallback(observer);
            if(status!=SM_SUCCESS) throw std::runtime_error("actual unobserved affine fixture failed");
            plan.complete_place();
        } else if(std::strcmp(mode,"late")!=0) plan.place(placement,&scale);
        if(std::strcmp(mode,"source")==0 || std::strcmp(mode,"sibling")==0 || std::strcmp(mode,"target")==0) {
            auto& body=std::strcmp(mode,"source")==0?source:(std::strcmp(mode,"sibling")==0?sibling:working);
            SmTArray<SmFace*> faces; body.GetFaces(faces);
            ULONG nu=0,nv=0; double* controls=nullptr;
            if(static_cast<SmBSplineSurface*>(faces[0]->GetSurface())->GetControlPointsPointer(nu,nv,controls)!=SM_SUCCESS || !controls)
                throw std::runtime_error("negative affine fixture lacks real rational controls");
            controls[0]+=.125; // Raw SDK coefficient pointer: deliberately no notification.
        }
        plan.finish();
    }
};
}
void run_affine_lineage_negative(const char* mode) {
    using namespace face_lineage;
    auto source=OwnedBoundary::box(2,3,4); auto sibling=source.copy();
    auto& ledger=const_cast<Ledger&>(OwnedBoundaryTestAccess::ledger(source));
    auto& original=const_cast<SmBrep&>(OwnedBoundaryTestAccess::solid(source));
    auto& foreign=const_cast<SmBrep&>(OwnedBoundaryTestAccess::solid(sibling));
    SmCopyBrepMap map; auto working=checked_brep_copy(&original,&ledger,&map);
    bool rejected=false;
    try { AffineTransitionTestAccess::exercise(ledger,original,*working,foreign,map,mode); }
    catch(const KernelDomainTainted&) { rejected=true; }
    if(kernel_domain_is_tainted()) working.release();
    if(!rejected || !kernel_domain_is_tainted())
        throw std::runtime_error("affine transition rejects unreported edits and incomplete receipts");
    bool refused=false;
    try { (void)sibling.faces(); } catch(const KernelDomainTainted&) { refused=true; }
    if(!refused) throw std::runtime_error("affine transition failure retires the entire owner domain");
}
