// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <cstdint>
// Typed, recoverable adapter refusal carrying a C ABI status and static text.
struct AdapterFailure { int32_t status; const char* message; };
