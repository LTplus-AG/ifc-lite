// SPDX-License-Identifier: MPL-2.0
// Program invariant: copied topology and finite clipping observe the original
// shared tolerance policy DURING SDK work as well as after success/refusal.
// Actual SDK witnesses; execution remains parent-coordinated and UNRUN here.
#include "context_metadata.hpp"
#include "copy.hpp"
#include "empty.hpp"
#include "plane.hpp"
#include "sweep.hpp"
#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmApiQueries.h>
#include <SmBSplineCurve.h>
#include <SmEdgeuse.h>
#include <SmTol.h>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
namespace {
void require(bool value,const char* message) {
    if(!value) { std::fprintf(stderr,"context metadata FAIL: %s\n",message); std::exit(1); }
}
bool bits(double a,double b) { return std::memcmp(&a,&b,sizeof(a))==0; }
bool same(raw_context::Metadata a,raw_context::Metadata b) {
    return bits(a.size,b.size) && bits(a.ratio,b.ratio) && bits(a.zone,b.zone);
}
struct Effective { double size,ratio,zone; };
Effective effective(const SmBrep& b) {
    return {SmTol::GetModelSizeEstimate(b),SmTol::GetLargeSmallSizeRatio(b),b.GetTolerance()};
}
bool same(Effective a,Effective b) {
    return bits(a.size,b.size) && bits(a.ratio,b.ratio) && bits(a.zone,b.zone);
}
struct Observation {
    SmContext* context;
    SmBrep *source,*sibling;
    raw_context::Metadata context_raw,source_raw,sibling_raw;
    Effective source_effective,sibling_effective;
    Observation(SmContext* c,SmBrep* a,SmBrep* b):context(c),source(a),sibling(b),
        context_raw(raw_context::Access<SmContext>::get(*c)),
        source_raw(raw_context::Access<SmBrep>::get(*a)),sibling_raw(raw_context::Access<SmBrep>::get(*b)),
        source_effective(effective(*a)),sibling_effective(effective(*b)) {}
    void check() const {
        require(same(context_raw,raw_context::Access<SmContext>::get(*context)),"exact raw shared context size/ratio/zone");
        require(same(source_raw,raw_context::Access<SmBrep>::get(*source)),"exact raw original source metadata and DEFAULT sentinels");
        require(same(sibling_raw,raw_context::Access<SmBrep>::get(*sibling)),"exact raw sibling metadata and DEFAULT sentinels");
        require(same(source_effective,effective(*source)) && same(sibling_effective,effective(*sibling)),
            "original and sibling effective inherited tolerance policy");
    }
};
class ObservingTrim final:public SmBSplineCurve {
    const Observation& observation;
    unsigned& calls;
public:
    ObservingTrim(const SmBSplineCurve& real,const Observation& o,unsigned& count):
        SmBSplineCurve(real),observation(o),calls(count) {}
    SmStatus Copy(const SmContext& context,SmCurve*& output) const override {
        require(&context==observation.context,"actual MergeBrep uses expected shared context");
        observation.check(); ++calls;
        return SmBSplineCurve::Copy(context,output); // Copy real SDK geometry.
    }
};
void scenario(bool explicit_context,bool source_defaults) {
    auto* context=SmApiGetOrCreateContext(); require(context,"live SDK context");
    raw_context::Restore original(context); // Includes fixture setup/destruction.
    SmBrep *a=nullptr,*b=nullptr;
    require(SmApiCreateBox(SmVector3d(0,0,0),2,2,2,a)==SM_SUCCESS && a,"actual shared-context host");
    std::unique_ptr<SmBrep> source(a);
    require(SmApiCreateBox(SmVector3d(10,0,0),2,2,2,b)==SM_SUCCESS && b,"actual shared-context sibling");
    std::unique_ptr<SmBrep> sibling(b);
    auto ctx=raw_context::Access<SmContext>::get(*context);
    ctx.size=explicit_context?1234:SM_USE_DEFAULT; ctx.ratio=explicit_context?321:SM_USE_DEFAULT;
    ctx.zone=explicit_context?1.25e-4:SM_USE_DEFAULT; raw_context::Access<SmContext>::set(*context,ctx);
    auto metadata=raw_context::Access<SmBrep>::get(*source);
    metadata.size=source_defaults?SM_USE_DEFAULT:100;
    metadata.ratio=source_defaults?SM_USE_DEFAULT:99;
    metadata.zone=source_defaults?SM_USE_DEFAULT:2e-4;
    raw_context::Access<SmBrep>::set(*source,metadata);
    metadata.size=SM_USE_DEFAULT; metadata.ratio=SM_USE_DEFAULT; metadata.zone=SM_USE_DEFAULT;
    raw_context::Access<SmBrep>::set(*sibling,metadata);
    Observation state(context,source.get(),sibling.get()); unsigned calls=0;
    SmTArray<SmEdgeuse*> uses; source->GetEdgeuses(uses);
    require(uses.GetSize()>0 && uses[0]->GetUVTrimCurve(),"existing actual SDK UV trim");
    auto* observed=new (*context) ObservingTrim(*uses[0]->GetUVTrimCurve(),state,calls);
    uses[0]->SetUVTrimCurve(observed,0,TRUE); state.check();
    {
        auto copy=checked_brep_copy(source.get());
        require(calls>0,"context observed inside actual MergeBrep trim copy"); state.check();
        require(same(state.source_raw,raw_context::Access<SmBrep>::get(*copy)) &&
            same(state.source_effective,effective(*copy)),"copy retains raw and effective source policy");
    }
    state.check();
    for(double x:{0.5,3.}) {
        calls=0; const double plane[]={x,0,0,1,0,0}; ifclite_smlib_plane_certificate certificate{};
        auto result=clip_finite_plane(source.get(),plane,1,IFCLITE_SMLIB_INTERSECTION,certificate);
        require(calls>0,"clip host copy observed intermediate context"); state.check();
        require(certificate.empty==(x==3?1u:0u) && semantically_empty_brep(result.get())==(x==3),
            "actual nonempty and Empty outcomes under preserved shared policy");
        if(x==0.5) {
            double volume=0; require(SmApiBrepComputeVolume(result.get(),1e-8,volume)==SM_SUCCESS &&
                std::abs(volume-6)<1e-4,"actual successful nonempty clip volume");
        }
    }
    state.check();
    const double plane[]={0.5,0,0,1,0,0}; ifclite_smlib_plane_certificate certificate{}; bool refused=false;
    try { clip_finite_plane(source.get(),plane,1,IFCLITE_SMLIB_UNION,certificate); }
    catch(const SweepFailure& e) { refused=e.status==IFCLITE_SMLIB_UNSUPPORTED; }
    require(refused && !kernel_domain_is_tainted(),"typed refusal preserves usable context"); state.check();
    auto empty=raw_context::construct_brep(context); state.check();
    const auto empty_metadata=raw_context::Access<SmBrep>::get(*empty);
    auto result=clip_finite_plane(empty.get(),plane,1,IFCLITE_SMLIB_INTERSECTION,certificate);
    require(certificate.empty==1 && semantically_empty_brep(result.get()) &&
        same(empty_metadata,raw_context::Access<SmBrep>::get(*empty)),"empty-input copy preserves raw source policy");
    state.check();
}
}
void run_context_metadata_tests() {
    for(bool context:{false,true}) for(bool defaults:{false,true}) scenario(context,defaults);
}
