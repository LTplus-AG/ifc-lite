// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Cross-platform sign manifest (G2 L1 slice) — the determinism-bar proof for
//! the predicate layer.
//!
//! A fixed-seed battery of every indirect + explicit predicate configuration,
//! FNV-1a-hashed over the result SIGNS. Exact predicate signs are integer
//! parity over FMA-free IEEE-754 arithmetic (Rust does not auto-contract float
//! ops; the kernel has no `mul_add`), so the manifest MUST be byte-identical on
//! x86_64 / aarch64 / wasm. The pinned constant catches any sign-logic
//! regression; running the SAME value on all three targets (the CI matrix +
//! the local wasm cross-check) proves the topology-determinism bar for L1.

use super::predicates::{cmp_lex, orient2d, orient2d_2i, orient2d_3i, orient3d};
use super::{DropAxis, ImplicitPoint, Lpi, Sign, Tpi};

/// Deterministic LCG (fixed seed — reproducible across targets).
struct ManifestRng(u64);
impl ManifestRng {
    fn u(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0
    }
    /// Building-scale coordinate in [-50, 50).
    fn f(&mut self) -> f64 {
        let unit = (self.u() >> 11) as f64 / (1u64 << 53) as f64;
        -50.0 + 100.0 * unit
    }
    fn p(&mut self) -> [f64; 3] {
        [self.f(), self.f(), self.f()]
    }
}

#[inline]
fn mix(h: &mut u64, s: Sign) {
    let code: u8 = match s {
        Sign::Negative => 0,
        Sign::Zero => 1,
        Sign::Positive => 2,
    };
    *h ^= code as u64;
    *h = h.wrapping_mul(0x0000_0100_0000_01b3); // FNV-1a prime
}

/// FNV-1a hash over the signs of a fixed battery of predicate calls across all
/// supported `ImplicitPoint` configurations. Platform-independent by the
/// determinism argument above.
pub fn indirect_sign_manifest() -> u64 {
    let mut rng = ManifestRng(0x9e37_79b9_7f4a_7c15);
    let mut h: u64 = 0xcbf2_9ce4_8422_2325; // FNV-1a offset basis
    for _ in 0..1000 {
        let l = Lpi { p: rng.p(), q: rng.p(), r: rng.p(), s: rng.p(), t: rng.p() };
        let t = Tpi {
            planes: [
                [rng.p(), rng.p(), rng.p()],
                [rng.p(), rng.p(), rng.p()],
                [rng.p(), rng.p(), rng.p()],
            ],
        };
        let l2 = Lpi { p: rng.p(), q: rng.p(), r: rng.p(), s: rng.p(), t: rng.p() };
        let ea = ImplicitPoint::Explicit(rng.p());
        let eb = ImplicitPoint::Explicit(rng.p());
        let ec = ImplicitPoint::Explicit(rng.p());
        let il = ImplicitPoint::Lpi(l);
        let it = ImplicitPoint::Tpi(t);
        let il2 = ImplicitPoint::Lpi(l2);
        // orient3d (explicit, LPI-1I, TPI-1I)
        mix(&mut h, orient3d(&ea, &eb, &ec, &ImplicitPoint::Explicit(l.p)));
        mix(&mut h, orient3d(&il, &ea, &eb, &ec));
        mix(&mut h, orient3d(&it, &ea, &eb, &ec));
        // orient2d 1I
        mix(&mut h, orient2d(&il, &ea, &eb, DropAxis::Z));
        mix(&mut h, orient2d(&it, &ea, &eb, DropAxis::X));
        mix(&mut h, orient2d(&il, &eb, &ec, DropAxis::Y));
        // mixed-implicit configs: orient2d 2I / 3I + cmp_lex (all through the cascade)
        mix(&mut h, orient2d_2i(&il, &il2, rng.p(), DropAxis::Z));
        mix(&mut h, orient2d_2i(&it, &il2, rng.p(), DropAxis::X));
        mix(&mut h, orient2d_3i(&il, &it, &il2, DropAxis::Y));
        mix(&mut h, cmp_lex(&il, &it));
        mix(&mut h, cmp_lex(&il, &il2));
        mix(&mut h, cmp_lex(&it, &ImplicitPoint::Explicit(l.p)));
    }
    h
}

#[cfg(test)]
mod tests {
    use super::indirect_sign_manifest;

    /// Pinned cross-platform determinism fingerprint (G2 L1 slice). If this
    /// changes: either the predicate sign logic changed (intended → re-pin and
    /// re-run the wasm/ARM cross-check) or determinism broke (investigate).
    const SIGN_MANIFEST: u64 = 0xdd1d_d6b0_0013_0af5;

    #[test]
    fn indirect_sign_manifest_is_pinned() {
        let m = indirect_sign_manifest();
        assert_eq!(
            m, SIGN_MANIFEST,
            "indirect predicate sign manifest changed: 0x{m:016x} (re-pin if intended, then re-run the cross-platform check)"
        );
    }
}
