// SPDX-License-Identifier: MPL-2.0
// Invariant: copied topology observes the original shared tolerance policy
// DURING SDK work as well as after success. Actual SDK witnesses.
#include "context_metadata.hpp"
#include "copy.hpp"
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
    std::fprintf(stderr,"context metadata BEGIN scenario explicit_context=%u source_defaults=%u\n",
        unsigned(explicit_context),unsigned(source_defaults));
    auto* context=SmApiGetOrCreateContext(); require(context,"live SDK context");
    raw_context::Restore original(context); // Includes fixture setup/destruction.
    SmBrep *a=nullptr,*b=nullptr;
    require(SmApiCreateBox(SmVector3d(0,0,0),2,2,2,a)==SM_SUCCESS && a,"actual shared-context host");
    std::unique_ptr<SmBrep> source(a);
    require(SmApiCreateBox(SmVector3d(10,0,0),2,2,2,b)==SM_SUCCESS && b,"actual shared-context sibling");
    std::unique_ptr<SmBrep> sibling(b);
    auto ctx=raw_context::Access<SmContext>::get(*context);
    ctx.size=explicit_context?1234:SM_USE_DEFAULT; ctx.ratio=explicit_context?321:SM_USE_DEFAULT;
    // Keep the actual box creation policy. SDK ValidatePointers tests6/60/83
    // require face/edge/vertex zones >0.99*BRep zone. Replacing only the BRep
    // zone after creation makes valid topology inconsistent (actual job483755e8
    // reported six test6 failures and edge test60 failures).
    // Size/ratio DEFAULT inheritance is independent of this cached zone.
    require(std::isfinite(ctx.zone) && ctx.zone>0 && ctx.zone<1e-3,"finite shared context zone for two-unit geometry");
    raw_context::Access<SmContext>::set(*context,ctx);
    auto metadata=raw_context::Access<SmBrep>::get(*source);
    metadata.size=source_defaults?SM_USE_DEFAULT:100;
    metadata.ratio=source_defaults?SM_USE_DEFAULT:99;
    raw_context::Access<SmBrep>::set(*source,metadata);
    metadata=raw_context::Access<SmBrep>::get(*sibling);
    metadata.size=SM_USE_DEFAULT; metadata.ratio=SM_USE_DEFAULT;
    raw_context::Access<SmBrep>::set(*sibling,metadata);
    Observation state(context,source.get(),sibling.get()); unsigned calls=0;
    SmTArray<SmEdgeuse*> uses; source->GetEdgeuses(uses);
    require(uses.GetSize()>0 && uses[0]->GetUVTrimCurve(),"existing actual SDK UV trim");
    auto* observed=new (*context) ObservingTrim(*uses[0]->GetUVTrimCurve(),state,calls);
    uses[0]->SetUVTrimCurve(observed,0,TRUE); state.check();
    {
        std::fprintf(stderr,"context metadata BEGIN checked copy\n");
        auto copy=checked_brep_copy(source.get());
        require(calls>0,"context observed inside actual MergeBrep trim copy"); state.check();
        require(same(state.source_raw,raw_context::Access<SmBrep>::get(*copy)) &&
            same(state.source_effective,effective(*copy)),"copy retains raw and effective source policy");
    }
    state.check();
    state.check();
}
void sentinel_zone_copy_only() {
    std::fprintf(stderr,"context metadata BEGIN raw sentinel empty copy\n");
    // Raw metadata compatibility only:9876543.21 is NOT a valid inherited zone
    // for clipping a two-unit model. Use empty SDK topology without geometry,
    // and invoke no clipping, volume or positive geometry oracle here.
    auto* context=SmApiGetOrCreateContext(); raw_context::Restore original(context);
    auto source=raw_context::construct_brep(context);
    auto metadata=raw_context::Access<SmBrep>::get(*source);
    metadata.size=SM_USE_DEFAULT; metadata.ratio=SM_USE_DEFAULT; metadata.zone=SM_USE_DEFAULT;
    raw_context::Access<SmBrep>::set(*source,metadata);
    raw_context::Access<SmContext>::set(*context,metadata);
    auto copy=checked_brep_copy(source.get());
    require(same(metadata,raw_context::Access<SmBrep>::get(*copy)) &&
        same(metadata,raw_context::Access<SmBrep>::get(*source)) &&
        same(metadata,raw_context::Access<SmContext>::get(*context)),
        "arbitrary raw zone sentinel survives actual topology copying without geometry claims");
}
}
void run_context_metadata_tests() {
    for(bool context:{false,true}) for(bool defaults:{false,true}) scenario(context,defaults);
    sentinel_zone_copy_only();
}
