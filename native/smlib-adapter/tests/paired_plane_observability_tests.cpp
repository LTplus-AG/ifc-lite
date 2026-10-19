// SPDX-License-Identifier: MPL-2.0
// Actual SDK prerequisite witnesses, UNRUN until parent-coordinated execution.
// These do not implement or qualify a paired split. See PAIRED_PLANE_CONTRACT.md.
#include "context_metadata.hpp"
#include "copy.hpp"
#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmApiQueries.h>
#include <SmFace.h>
#include <SmVertex.h>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <vector>
namespace {
void require(bool value,const char* message) {
    if(!value) throw std::runtime_error(message);
}
bool bits(double a,double b) { return std::memcmp(&a,&b,sizeof(a))==0; }
bool same(raw_context::Metadata a,raw_context::Metadata b) {
    return bits(a.size,b.size) && bits(a.ratio,b.ratio) && bits(a.zone,b.zone);
}
struct Solids {
    std::unique_ptr<SmBrep> source,first,second;
    ~Solids() {
        if(kernel_domain_is_tainted()) {
            source.release(); first.release(); second.release();
        }
    }
};
// The callback allocates nothing and never throws through SDK notification.
// The SDK ignores its return status: the caller must inspect a separate latch.
// Restricting ownership to a vacant user callback slot preserves foreign hooks.
class CopyEvents final:public SmNotifyCallback {
    SmContext& context;
    std::array<SmFace*,64> from{};
    std::array<SmObject*,64> to{};
    unsigned count=0;
public:
    bool callback_refused=false,duplicate=false;
    CopyEvents(SmBrep& source):context(*const_cast<SmContext*>(source.GetContext())) {
        require(context.GetUserNotifyCallback()==nullptr,"foreign callback slot must remain untouched");
        SmTArray<SmFace*> faces; source.GetFaces(faces);
        require(faces.GetSize()>0 && faces.GetSize()<=from.size(),"bounded actual face inventory");
        count=faces.GetSize();
        for(unsigned i=0;i<count;++i) from[i]=faces[i];
        context.SetUserNotifyCallback(this);
    }
    CopyEvents(const CopyEvents&)=delete;
    CopyEvents& operator=(const CopyEvents&)=delete;
    ~CopyEvents() { context.SetUserNotifyCallback(nullptr); }
    SmStatus Execute(SmNotifyOperation event,SmObject* caller,
        SmObject* data1,SmObject*,SmObject*) override {
        if(event!=SM_NO_COPY) return SM_SUCCESS;
        for(unsigned i=0;i<count;++i) if(caller==from[i]) {
            if(to[i]!=nullptr) duplicate=true;
            // An SDK event's typed source is known from the captured inventory;
            // defer target type/ownership checks until the SDK call completes.
            to[i]=data1;
            callback_refused=true;
            return SM_ERR;
        }
        return SM_SUCCESS;
    }
    std::vector<SmFace*> verify(SmBrep& target) const {
        require(callback_refused && !duplicate,"every source face notified once despite callback error");
        SmTArray<SmFace*> live; target.GetFaces(live);
        require(live.GetSize()==count,"copy has exactly the source face cardinality");
        std::vector<SmFace*> result;
        for(unsigned i=0;i<count;++i) {
            unsigned matches=0; SmFace* matched=nullptr;
            for(auto* face:live) if(face==to[i]) { ++matches; matched=face; }
            require(to[i] && matches==1 && to[i]!=from[i],"actual copy target is live and independently owned");
            for(unsigned j=0;j<i;++j) require(to[i]!=to[j],"face copy relation is injective");
            require(matched->GetBrep()==&target,"mapped face belongs to the checked output");
            result.push_back(matched);
        }
        return result; // ordered by the captured source inventory, not a geometric match
    }
    SmObject* copied(SmFace* source) const {
        for(unsigned i=0;i<count;++i) if(from[i]==source) return to[i];
        throw std::runtime_error("unknown copy source face");
    }
};
void witness(bool cylinder,bool rational) {
    const char* name=cylinder?"cylinder":rational?"generic-nurbs-box":"box";
    std::fprintf(stderr,"paired prerequisite BEGIN %s (copy observability only)\n",name);
    auto* context=SmApiGetOrCreateContext(); raw_context::Restore preserve(context);
    Solids owned;
    SmBrep* raw=nullptr;
    try {
        const auto status=cylinder?SmApiCreateCylinder(SmVector3d(0,0,0),1,2,raw):
            SmApiCreateBox(SmVector3d(0,0,0),2,2,2,raw);
        owned.source.reset(raw);
        require(status==SM_SUCCESS && raw,"actual SDK primitive construction");
    }
    catch(...) { rethrow_tainted_kernel_domain("paired prerequisite primitive construction"); }
    if(rational) {
        try { require(raw->TurnToNURBS()==SM_SUCCESS,"actual SDK rational conversion"); }
        catch(...) { rethrow_tainted_kernel_domain("paired prerequisite rational conversion"); }
        SmTArray<SmFace*> faces; raw->GetFaces(faces);
        for(auto* face:faces) require(face->GetSurface()->GetType()==SmBSplineSurface_TYPE,
            "rational fixture reached actual generic surface representations");
    }
    const auto metadata=raw_context::Access<SmBrep>::get(*raw);
    const auto policy=raw_context::Access<SmContext>::get(*context);
    SmTArray<SmVertex*> before; raw->GetVertices(before);
    std::vector<SmPoint3d> points; for(auto* vertex:before) points.push_back(vertex->GetPoint());
    std::vector<SmFace*> first_faces,second_faces;
    {
        CopyEvents events(*raw);
        owned.first=checked_brep_copy(raw);
        first_faces=events.verify(*owned.first);
    }
    require(context->GetUserNotifyCallback()==nullptr,"user callback slot restored after first copy");
    require(same(metadata,raw_context::Access<SmBrep>::get(*raw)) &&
        same(policy,raw_context::Access<SmContext>::get(*context)),"source and context raw metadata preserved");
    SmTArray<SmVertex*> after; raw->GetVertices(after);
    require(after.GetSize()==before.GetSize(),"source vertex count preserved");
    for(ULONG i=0;i<after.GetSize();++i) {
        const auto p=after[i]->GetPoint();
        require(after[i]==before[i] && bits(p.x,points[i].x) && bits(p.y,points[i].y) && bits(p.z,points[i].z),
            "source vertex identity and coordinate bits preserved");
    }
    {
        CopyEvents events(*owned.first);
        owned.second=checked_brep_copy(owned.first.get());
        const auto verified=events.verify(*owned.second);
        for(auto* face:first_faces) {
            SmFace* mapped=nullptr;
            for(auto* candidate:verified) if(candidate==events.copied(face)) mapped=candidate;
            require(mapped,"composed copy relation reaches a verified live face");
            second_faces.push_back(mapped);
        }
    }
    require(context->GetUserNotifyCallback()==nullptr,"user callback slot restored after second copy");
    owned.source.reset(); owned.first.reset();
    // Dereference only live second-copy faces. The composed relation was
    // captured while both dependencies were alive; no stale pointer lookup.
    for(auto* face:second_faces) require(face->GetBrep()==owned.second.get(),"transitive copy target survives dependency release");
    SmBoolean manifold=FALSE;
    require(SmApiBrepIsManifoldSolid(owned.second.get(),manifold)==SM_SUCCESS && manifold,"surviving actual copied solid is manifold");
    double volume=0;
    require(SmApiBrepComputeVolume(owned.second.get(),1e-8,volume)==SM_SUCCESS && std::isfinite(volume),"actual copied solid volume evaluated");
    const double expected=cylinder?2*std::acos(-1.):8;
    require(std::abs(volume-expected)<=expected*2e-5,"analytic volume survives two actual copies and dependency release");
    require(!kernel_domain_is_tainted(),"successful prerequisite never taints isolation");
    std::fprintf(stderr,"paired prerequisite PASS %s; NOT paired geometry qualification\n",name);
}
}
int main() {
    try { witness(false,false); witness(true,false); witness(false,true); }
    catch(const KernelDomainTainted& error) {
        std::fprintf(stderr,"paired prerequisite TAINTED: %s\n",error.message.c_str()); return 1;
    } catch(const std::exception& error) {
        std::fprintf(stderr,"paired prerequisite FAIL: %s\n",error.what()); return 1;
    }
    return 0;
}
