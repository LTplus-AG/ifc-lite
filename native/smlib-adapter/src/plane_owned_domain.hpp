// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "plane_domain.hpp"
#include <memory>
// Operation-local ownership, not persistent ancestry or caller evidence. The
// source must remain live for this synchronous operation. Never exported over
// the ABI. Cannot be copied/moved/replayed against another BRep or handle slot.
class PreparedPlaneOperand {
    SmBrep* source_;
    std::unique_ptr<SmBrep> owned_;
    std::vector<uint64_t> source_inventory_,owned_inventory_;
    PlaneDomain domain_;
    bool consumed_=false;
public:
    explicit PreparedPlaneOperand(SmBrep* source);
    ~PreparedPlaneOperand();
    PreparedPlaneOperand(const PreparedPlaneOperand&)=delete;
    PreparedPlaneOperand& operator=(const PreparedPlaneOperand&)=delete;
    SmBrep* get() const { return owned_.get(); }
    const PlaneDomain& domain() const { return domain_; }
    void verify_source() const;
    void verify(SmBrep* expected) const;
    std::unique_ptr<SmBrep> consume(SmBrep* expected);
};
