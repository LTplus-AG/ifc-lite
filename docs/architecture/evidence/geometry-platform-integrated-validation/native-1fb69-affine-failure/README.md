<!-- SPDX-License-Identifier: MPL-2.0 -->
# Actual native1fb69 boundary failure

All265 build/link steps completed on PC. Four of five CTests passed; owned boundary failed its affine source-class conversion assertion after the semantic Empty identity cases. Later affine numerical and plane witnesses did not execute. The command intentionally stops before runtime/processing worker tests when CTest fails.

The raw source remains unchanged and clean. This is actual failed qualification, not a protocol-only verdict. Added diagnostics retain the original assertion and all numerical/count/tolerance oracles while the source-class mismatch is investigated.


A small existing-worker protocol diagnostic (two fixed primitive copies,0.021s,
no build) disambiguates the source-class assertion. Box reports12Lines+6Planes;
the C ABI cylinder reports1Line+2Circles+2Planes+1Cone. The pinned BRep cylinder
constructor actually builds an equal-radius SmCone; its separate surface-only
constructor builds SmCylinder. Primary source independently explains all12
counters. Root4545b755d7 requires those exact complete tables and keeps every
subsequent numerical oracle unchanged. This diagnostic is not a qualification
pass. The remaining actual SmCylinder-family coverage and plane zero-angle-cone
dispatch are separate requirements.
