// SPDX-License-Identifier: MPL-2.0
#pragma once
class SmBrep;
// Failure-only, bounded diagnostic. Never changes the tested output or verdict.
void diagnose_patch_accuracy(SmBrep* output, double x, double y, double z);
