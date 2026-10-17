# Math home (#7772, PR G1)

`behaviour.oracle.patch` is the revert-oracle mutation for the `ifc_lite_geometry::math` home. The step that applies it is "Prove the changed tests observe the production change" in `.github/workflows/test.yml`.

The PR adds a whole module and the changed geometry tests call it (`math::v3::dot`), so a whole-change revert cannot compile them (REVERT-BROKE-BUILD). This patch keeps the module and disables ONLY:

| guard disabled | where | tests that turn red |
|---|---|---|
| `canonical` tie rule `ay >= az` becomes `ay > az` | `math/v3.rs` | `canonical_parity_tests`, `v3_tests` |
| `normalize` refuses `< min_len` instead of `<= min_len` | `math/v3.rs` | `v3_tests` |
| conjugation drops the `+ 0.0` sign-of-zero fold | `math/frame.rs` | `frame_tests` |
| `affine_inverse` stops refusing a non-finite determinant | `math/mat4.rs` | `mat4_tests` |

Once `math/mod.rs` is on `main`, the ordinary whole-change revert resumes automatically.
