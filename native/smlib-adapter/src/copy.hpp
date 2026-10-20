// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <SmBrep.h>
#include <memory>
#include <string>
struct KernelDomainTainted { std::string message; };
bool kernel_domain_is_tainted();
[[noreturn]] void rethrow_tainted_kernel_domain(const char* stage);
// Checked public MergeBrep, with analytic recognition disabled. Composite
// topology is explicitly unsupported by the pinned SDK copy implementation.
std::unique_ptr<SmBrep> checked_brep_copy(const SmBrep* source);
