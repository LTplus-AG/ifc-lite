// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pure-Rust exact mesh-arrangement CSG kernel — predicate foundation.
//!
//! This layer provides exact, platform-deterministic geometric predicates over
//! a mix of EXPLICIT input points and IMPLICIT intersection points (LPI =
//! line∩plane, TPI = three planes) carried symbolically and never materialised
//! to a float decision.
//!
//! Determinism: signs are integer parity over deterministic arithmetic. The
//! explicit path goes through `geometry-predicates` (FMA-free, const error
//! bounds). The EXACT (BigRational) tier is correct by construction and is the
//! oracle for the faster interval/fixed-width tiers, each verified `≡` exact.

pub mod arrangement;
pub mod broadphase;
pub mod budget;
pub mod coplanar;
pub mod fixed;
pub mod interner;
pub mod interval;
pub mod manifest;
pub mod mesh_bridge;
pub mod predicates;
pub mod rational;
mod signed_volume;
pub mod retriangulate;
mod retriangulate_audit;
mod retriangulate_cleanup;
mod retriangulate_recover;
pub mod tritri;

/// Three-valued exact sign.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Sign {
    Negative,
    Zero,
    Positive,
}

impl Sign {
    #[inline]
    pub fn from_f64(x: f64) -> Sign {
        if x < 0.0 {
            Sign::Negative
        } else if x > 0.0 {
            Sign::Positive
        } else {
            Sign::Zero
        }
    }

    /// Flip the sign (Zero is fixed). Used by the per-configuration denominator
    /// flip in [`assemble_sign`].
    #[inline]
    pub fn flip(self) -> Sign {
        match self {
            Sign::Positive => Sign::Negative,
            Sign::Negative => Sign::Positive,
            Sign::Zero => Sign::Zero,
        }
    }
}

/// Which axis to drop when projecting a 3D predicate to 2D (orient2d).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DropAxis {
    X,
    Y,
    Z,
}

/// A point that is either an explicit input coordinate or an implicit
/// intersection point carried symbolically over the original input coords.
#[derive(Clone, Debug)]
pub enum ImplicitPoint {
    Explicit([f64; 3]),
    /// Line `PQ` ∩ plane `RST`.
    Lpi(Lpi),
    /// Three planes concurrent (each a triangle: 3 points).
    Tpi(Tpi),
}

/// Line–plane implicit point: line through `p,q` ∩ plane through `r,s,t`.
#[derive(Clone, Copy, Debug)]
pub struct Lpi {
    pub p: [f64; 3],
    pub q: [f64; 3],
    pub r: [f64; 3],
    pub s: [f64; 3],
    pub t: [f64; 3],
}

/// Three-plane implicit point: `planes[i]` is a triangle (3 points) defining a plane.
#[derive(Clone, Copy, Debug)]
pub struct Tpi {
    pub planes: [[[f64; 3]; 3]; 3],
}

/// Combine the sign of the homogenised determinant `Λ′` with the
/// per-configuration denominator flip.
///
/// When an implicit point `(λ/d)` enters a determinant row, clearing the
/// denominator multiplies the determinant by `d` (degree = the denominator's
/// multiplicity in that configuration). The geometric sign therefore equals
/// `sign(Λ′)` flipped once per NEGATIVE odd-multiplicity denominator.
/// `den_signs` lists ONLY the odd-multiplicity denominator signs — squared
/// denominators (e.g. the TPI `III` orient3d case, `D′=(d1d2d3d4)²`) cannot
/// change the sign and MUST NOT be included. Getting this wrong silently
/// inverts inside/outside for ~half of real cuts (the per-config rule, not a
/// blanket XOR over all negatives — see the spec's REFUTATION-FIX).
///
/// A `Zero` denominator means a degenerate / at-infinity construction (e.g. the
/// LPI line is parallel to the plane, `d=0`): the predicate is undefined, so we
/// return `Zero`. Valid implicit points (built only for genuinely-crossing
/// edges) never have a zero denominator.
#[inline]
pub fn assemble_sign(lambda_det_sign: Sign, den_signs: &[Sign]) -> Sign {
    let mut negatives = 0u32;
    for &d in den_signs {
        match d {
            Sign::Negative => negatives += 1,
            Sign::Zero => return Sign::Zero,
            Sign::Positive => {}
        }
    }
    if negatives % 2 == 1 {
        lambda_det_sign.flip()
    } else {
        lambda_det_sign
    }
}
