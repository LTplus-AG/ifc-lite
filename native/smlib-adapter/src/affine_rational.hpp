// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <SmBrep.h>
#include <memory>
// Only called during fixed owned construction, BEFORE any roots are issued.
// All analytic families accepted by affine preflight use this same conversion.
void normalize_owned_rational(SmBrep&);

namespace face_lineage { class SourceConstruction; }
void normalize_constructed_rational(SmBrep&,const face_lineage::SourceConstruction&);
class SmBSplineSurface;
std::unique_ptr<SmBSplineSurface> copy_initial_surface(SmBrep&,SmBSplineSurface&,const face_lineage::SourceConstruction&);
