// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <SmBrep.h>
#include <cstdint>
#include <memory>
#include <vector>
struct SweepFailure { int32_t status; const char* message; };
// Numerical recipe only, never IFC interpretation. Format is documented in ABI.
std::unique_ptr<SmBrep> create_authored_sweep(const std::vector<uint8_t>& bytes,
    uint32_t loops, uint32_t segments);
