// SPDX-License-Identifier: MPL-2.0
// Actual SDK topology copying with a deterministic virtual trim-copy failure.
// The failure injection supplies no geometry; all curves/topology are real box
// data. It distinguishes checked MergeBrep from its unchecked copy constructor.
#include "copy.hpp"
#include "ifclite_smlib.h"
#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmBSplineCurve.h>
#include <SmEdgeuse.h>
#include <SmTol.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
namespace {
void require(bool x,const char* label) {
    if(!x) { std::fprintf(stderr,"copy failure witness: %s\n",label); std::exit(1); }
}
class FailingTrim final:public SmBSplineCurve {
public:
    explicit FailingTrim(const SmBSplineCurve& source):SmBSplineCurve(source) {}
    SmStatus Copy(const SmContext&,SmCurve*& output) const override { output=nullptr; return SM_ERR; }
};
}
void run_copy_failure_tests() {
    SmBrep* raw=nullptr;
    require(SmApiCreateBox(SmVector3d(0,0,0),2,3,4,raw)==SM_SUCCESS && raw,"actual box source");
    std::unique_ptr<SmBrep> source(raw);
    auto& context=*const_cast<SmContext*>(source->GetContext());
    SmTol::SetModelSizeEstimate(*source,SM_USE_DEFAULT);
    SmTol::SetLargeSmallSizeRatio(*source,SM_USE_DEFAULT);
    const double context_size=SmTol::GetModelSizeEstimate(context),context_ratio=SmTol::GetLargeSmallSizeRatio(context);
    const double source_zone=source->GetTolerance(),context_zone=SmTol::GetZoneTol3d(&context);
    auto copied=checked_brep_copy(source.get());
    require(source_zone==copied->GetTolerance(),"raw zone tolerance preserved");
    require(context_size==SmTol::GetModelSizeEstimate(context) && context_ratio==SmTol::GetLargeSmallSizeRatio(context) &&
        context_zone==SmTol::GetZoneTol3d(&context),"copy restores ambient context metadata");
    SmTol::SetModelSizeEstimate(context,1234);
    SmTol::SetLargeSmallSizeRatio(context,321);
    require(SmTol::GetModelSizeEstimate(*source)==SmTol::GetModelSizeEstimate(*copied) &&
        SmTol::GetLargeSmallSizeRatio(*source)==SmTol::GetLargeSmallSizeRatio(*copied),
        "copy preserves inherited DEFAULT sentinels under later context change");
    SmTol::SetModelSizeEstimate(context,context_size); SmTol::SetLargeSmallSizeRatio(context,context_ratio);
    copied.reset();
    uint64_t session=0; ifclite_smlib_handle ordinary{};
    require(ifclite_smlib_session_create(&session)==0 &&
        ifclite_smlib_box(session,0,0,0,1,1,1,&ordinary)==0,"unrelated live C ABI source before failure");
    SmTArray<SmEdgeuse*> uses; source->GetEdgeuses(uses);
    require(uses.GetSize()>0,"real edgeuses");
    SmBSplineCurve* original=nullptr;
    require(uses[0]->GetOrCreateUVTrimCurve(original)==SM_SUCCESS && original,"real SDK UV trim");
    auto* injected=new (context) FailingTrim(*original);
    uses[0]->SetUVTrimCurve(injected,0.,TRUE);
    bool failed=false;
    try { auto invalid=checked_brep_copy(source.get()); }
    catch(const KernelDomainTainted& e) { failed=e.message.find("topology copy failed")!=std::string::npos; }
    require(failed && kernel_domain_is_tainted(),"actual MergeBrep failure is terminal, never a partial success");
    require(uses[0]->GetUVTrimCurve()==injected,"source UV trim remains unchanged");
    double volume=0;
    require(ifclite_smlib_volume(session,ordinary,1e-8,&volume)==IFCLITE_SMLIB_TAINTED_DOMAIN,
        "tainted C ABI module rejects subsequent access even to unrelated handles");
    require(ifclite_smlib_session_destroy(session)==IFCLITE_SMLIB_TAINTED_DOMAIN,
        "tainted module cannot resume after session reset");
    // All SDK allocations, including unlinked partial copies, are reclaimed by
    // process exit. Do not claim destructor-only recovery or continue this lane.
}
