# Rigid correspondence foundation — #4381

These runs check the numerical solver and its integration boundary. They do not
supply CRAS correspondences, establish scan accuracy, or complete F4 transfer.

The [NumPy oracle](numpy-oracle.json) compares 40 rebuilt-WASM results with an
independent NumPy SVD over known rigid synthetic cases: 3/4/8/64 fitting points,
four checks, optional noise and large georeferenced offsets. Reproduce after
building WASM with `python3 tools/texture-authoring/scan-registration-oracle.py`.
The script has no network dependency or persistent temporary outputs.

Independent review additionally tested 180 thin distributions. It found a real
failure in nalgebra's specialized Matrix3 SVD: accepted inputs could produce a
substantially wrong rotation. Switching to bounded direct SVD and machine-epsilon
convergence resolved it. The two observed counterexamples are retained as
`registration_thin_fixture.json` and `registration_anisotropic_fixture.json` beside
the Rust implementation and exercised in both native and actual WASM tests.
The final independent sweep refused 17 degenerate inputs. Accepted maximum
held-out error was 3.154e-10 m; maximum rotation-component error near the declared
rank threshold was 7.935e-7. These are synthetic numerical results, not measured
real-scene accuracy or an uncertainty bound for manually chosen features.

The [native load probe](native-load-perf.json) compares base `946e60f0d` and the
final branch with separately built immutable profiling binaries. After builds
and tests stopped, runs alternate base/branch/branch/base, five iterations each.
All ordered fingerprints and mesh/vertex/triangle counts match. The ordinary
parse and geometry paths do not invoke the new opt-in registration API. This
native experiment is not a browser worker-pool performance claim.

Validation: full Rust workspace tests and strict all-target Clippy; rebuilt WASM
contract harness (84 passed, three fixture/optional-runtime skips); root Turbo
typecheck; documentation examples; module size, test wiring and source assertion
gates. The WASM test frees the API deterministically and independently verifies
request-digest serialization, held-out exclusion, frame identities and refusal
bounds. No large model or captured scan fixture is committed here.
