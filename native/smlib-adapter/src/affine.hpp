// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "ifclite_smlib.h"
#include <SmBrep.h>
#include <memory>
namespace face_lineage { class Ledger; class SourceConstruction; }
// Preparation is read-only and rejects non-certifiable source before copying.
// A failure after copying starts taints the kernel domain (see copy.hpp).
std::unique_ptr<SmBrep> copy_affine_rational(SmBrep* source, const double* matrix,
    ifclite_smlib_affine_certificate& certificate, face_lineage::Ledger* lineage=nullptr);
// Internal fixed constructor normalization before source-root issuance; uses
// the same rational eligibility and never fits/replaces original UV curves.
void prepare_owned_affine_source(SmBrep&);
void prepare_constructed_affine_source(SmBrep&,const face_lineage::SourceConstruction&);
