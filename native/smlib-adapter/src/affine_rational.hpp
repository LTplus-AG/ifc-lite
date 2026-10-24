// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <SmBrep.h>
// Only called during fixed owned construction, BEFORE any roots are issued.
// All analytic families accepted by affine preflight use this same conversion.
void normalize_owned_rational(SmBrep&);
