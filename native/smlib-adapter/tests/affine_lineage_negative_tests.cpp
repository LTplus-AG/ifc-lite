// SPDX-License-Identifier: MPL-2.0
// #7955: mutate actual SDK state without a notify and demand terminal refusal.
#include "affine_transition.hpp"
#include "owned_lineage_access.hpp"
#include "copy.hpp"
#include "failure.hpp"
#include <SmCopyBrepMap.h>
#include <SmVertex.h>
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
        if(std::strcmp(mode,"late")!=0) plan.place(placement,&scale);
        if(std::strcmp(mode,"receipt")==0) --plan.receipts;
        if(std::strcmp(mode,"source")==0 || std::strcmp(mode,"sibling")==0 || std::strcmp(mode,"target")==0) {
            auto& body=std::strcmp(mode,"source")==0?source:(std::strcmp(mode,"sibling")==0?sibling:working);
            SmTArray<SmVertex*> vertices; body.GetVertices(vertices);
            // GetPoint returns a const reference. Deliberately violate the SDK
            // const contract in this attack fixture; no notify can hide the edit.
            const_cast<SmPoint3d&>(vertices[0]->GetPoint()).x+=.125;
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
