// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "failure.hpp"
#include <SmBrep.h>
#include <cstdint>
#include <memory>
#include <vector>
// Numerical recipes only, never IFC interpretation. Formats are documented in
// the C ABI header. Refusals throw AdapterFailure; nothing is published.
namespace face_lineage { class SourceConstruction; }
std::unique_ptr<SmBrep> create_authored_sweep(const std::vector<uint8_t>& bytes,
    uint32_t loops, uint32_t segments, face_lineage::SourceConstruction* construction=nullptr);

std::unique_ptr<SmBrep> create_authored_disk(const std::vector<uint8_t>& bytes);
