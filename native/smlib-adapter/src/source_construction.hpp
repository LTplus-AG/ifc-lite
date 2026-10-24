// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "face_lineage.hpp"
#include <SmBrep.h>
#include <array>
#include <memory>
class SmCurve;
namespace face_lineage {
// Construction features, NEVER authored IfcFace identifiers or generated cut caps.
enum class SourceRole:uint32_t { SweptSegment=1,StartCap=2,EndCap=3 };
struct ConstructedFace { SmFace* face; uint64_t birth; SourceRole role; uint32_t ordinal; };
// A private, bounded, one-shot constructor. A caller cannot adopt an existing
// BRep or supply face pointers. Roles come from SDK constructor output arguments.
class SourceConstruction final:public SmNotifyCallback {
    struct Birth { SmObject* face=nullptr; uint64_t generation=0; bool live=false; };
    struct CapSplit { uint64_t parent=0,child=0; };
    struct CapPhase {
        bool active=false;
        uint32_t first_birth=0,limit=0,count=0;
        std::array<CapSplit,128> splits{};
    } cap_phase;
    SmContext& context;
    SmBrep* body=nullptr;
    std::array<Birth,1024> births{};
    uint32_t birth_count=0,event_count=0;
    bool failed=false,finished=false;
    std::vector<ConstructedFace> roles;
    void refuse(const char*,SmNotifyOperation,SmObject*,SmObject*,SmObject*,SmObject*) noexcept;
    void add(SmFace*,SourceRole,uint32_t);
    void cap(SmTArray<SmCurve*>&,SourceRole);
    void begin_cap(uint32_t);
    void finish_cap(const SmTArray<SmFace*>&);
    bool cap_split(SmNotifyOperation,SmObject*,SmObject*,SmObject*,SmObject*) noexcept;
    friend struct SourceConstructionTestAccess;
    void verify() const;
public:
    explicit SourceConstruction(SmContext&);
    ~SourceConstruction();
    SourceConstruction(const SourceConstruction&)=delete;
    SmStatus Execute(SmNotifyOperation,SmObject*,SmObject*,SmObject*,SmObject*) noexcept override;
    std::unique_ptr<SmBrep> construct(const SmTArray<SmCurve*>&,const SmVector3d&,double);
    void validate_initial(const SmBrep&) const;
    std::vector<ConstructedFace> finish(SmBrep&);
};
}
