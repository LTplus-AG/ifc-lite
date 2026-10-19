<!-- SPDX-License-Identifier: MPL-2.0 -->
# Correct actual retained empty classification — SDK execution pending

Source `8441381f54` replaces raw IsEmptyModel usage at both C ABI query19 and
tessellation admission with one strict SDK-topology certificate. The SDK constructor
allocates a void infinite region and nonnull auxiliary list headers even for no
geometry, whereas IsEmptyModel checks those pointers for null.

The helper requires absent faces, edges, vertices and shells, the actual infinite
region strictly void, and an owned region enumeration containing that pointer with
all regions strictly void. FALSE and UNSURE cannot certify emptiness. Query false
is not proof of valid finite material. No mesh count or volume guesses semantic
empty; constructors remain strict. Direct pinned-SDK regressions distinguish vacant,
full-space, unknown-region, box and wire objects. Existing Boolean identities and
zero-metadata oracles remain unchanged. Syntax-only parsing passed; independent
source review reports no concrete blocker for valid live SDK objects.

Fresh request `auto-78be6c8f65c14c6fa827b54c54f7a2fb` is bound to this source,
normal full build/CTest followed by actual-worker Rust runtime tests only if CTest
passes. It uses the existing open storage cohort ifclite-platform-sdk-5f39-20261019.
Historical SDK5f build/4-of-5 CTest failure remains separately archived.
