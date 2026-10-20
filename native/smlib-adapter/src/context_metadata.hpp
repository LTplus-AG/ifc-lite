// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <SmBrep.h>
#include <SmContext.h>
#include <memory>
namespace raw_context {
struct Metadata { double size,ratio; SmZoneTol3d zone; };
// Pin-specific legal protected-member pointers. Never instantiate these types
// or cast a Base to a derived object. Public getters chase DEFAULT sentinels;
// setters propagate/recompute policy, so neither preserves raw metadata.
template<class Base> struct Access: Base {
    static Metadata get(const Base& value) {
        return {value.*(&Access::m_dThisModelSizeEstimate),
            value.*(&Access::m_dThisLargeSmallSizeRatio),
            value.*(&Access::m_sThisZoneTol3d)};
    }
    static void set(Base& value,const Metadata& m) noexcept {
        value.*(&Access::m_dThisModelSizeEstimate)=m.size;
        value.*(&Access::m_dThisLargeSmallSizeRatio)=m.ratio;
        value.*(&Access::m_sThisZoneTol3d)=m.zone;
    }
};
class Restore {
    SmContext& context;
    Metadata metadata;
public:
    explicit Restore(const SmContext* c):context(*const_cast<SmContext*>(c)),
        metadata(Access<SmContext>::get(context)) {}
    Restore(const Restore&)=delete;
    Restore& operator=(const Restore&)=delete;
    void restore() const noexcept { Access<SmContext>::set(context,metadata); }
    ~Restore() { restore(); }
};
inline std::unique_ptr<SmBrep> construct_brep(const SmContext* context) {
    Restore preserve(context);
    auto result=std::unique_ptr<SmBrep>(new (*context) SmBrep());
    // The default ctor resets shared size/ratio/zone. Restore NOW: MergeBrep,
    // face construction and callbacks must observe the original policy, not
    // merely see it restored after the whole operation. Also restores on throw.
    preserve.restore();
    return result;
}
}
