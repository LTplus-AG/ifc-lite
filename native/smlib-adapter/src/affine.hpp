// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "ifclite_smlib.h"
#include <SmBrep.h>
#include <memory>
// Preparation is read-only and rejects non-certifiable source before copying.
std::unique_ptr<SmBrep> copy_affine_rational(SmBrep* source, const double* matrix,
    ifclite_smlib_affine_certificate& certificate);
