// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "ifclite_smlib.h"
#include <SmBrep.h>
#include <memory>
std::unique_ptr<SmBrep> clip_finite_plane(SmBrep* source,const double* plane,
    int32_t side,uint32_t mode,ifclite_smlib_plane_certificate& certificate);
