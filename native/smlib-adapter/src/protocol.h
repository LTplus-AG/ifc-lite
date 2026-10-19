// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <cstdint>
#include <vector>
// Malformed requests throw; caller must discard the entire worker incarnation.
std::vector<uint8_t> ifclite_smlib_dispatch(const std::vector<uint8_t>& request);
