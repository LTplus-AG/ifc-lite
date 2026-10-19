# Common unary final processing source closure review

Pinned final `20b605558c2556b97ed3f69c701122f747fb12c3`, exact base `775567f2bd1360fdf239fe96818cf7b1d3184c4c`. Compared the final immutable Git blobs with the earlier ccf review and its outstanding findings. No checkout changes, production edits, compilation, tests, SDK/browser execution or worker submissions. This is source closure only; it does not supersede the parent-reported SDK validation failures.

## Result

No remaining concrete processing source blocker found in this correction round. The three prior processing findings, exact-plane-bit binding and early retained header charge are corrected. Their behavioral witnesses remain UNRUN.

* `session_retained/acceptance.rs:78,106,109`: Difference-Empty policy is separate from structural/input/owner validation. Captured resource check now precedes the policy hold, ledger reserve, semantic outcome binding, stage CAS and original reply take. The original stop can also surface earlier from the same captured account during charged ledger validation. Healthy Difference-Empty still rejects intact with Unsupported; it never manufactures an uncut receipt. Native test `clip_tests.rs:242` delivers a real SDK Empty, then cancels or exhausts the original account and asserts the exact typed stop, DELIVERED stage, original pending reply and live original input/output. Browser counterpart `clip_browser_tests.rs:186` covers cancellation. Neither has been executed.
* `geometry/program/retained_clip.rs`: point/direction list reads and placement references now use generated Coordinates, DirectionRatios, Location, Axis and RefDirection slots. Raw coefficient/default/type/arity policy is preserved; no new attribute debt is hidden as vector indexing.
* `session_retained/issuance.rs:8`: clip descriptor is Box-owned, so the unary variant no longer embeds the large source/plane/frame payload. Its backing and logical-value backing are admitted at line76 before fallible copying and allocation. The permit remains refundable through `try_copy` and Box creation, and is retained only after the issued packet exists at line84. This closes the introduced phantom charge on a failed lineage copy. No compiler layout/Clippy run or allocation-failure witness was performed; existing non-unary charge patterns were outside this correction.
* `acceptance.rs:267`: all six expected local-plane coefficient bits are bound with `to_bits`, including signed zero. Native/browser tests substitute a genuinely sealed alternate zero-sign plane, require intact rejection, then restore and accept the original packet. No caller-fabricated positive receipt is introduced.

## Sign, frames and witnesses

The final side projection (`issuance.rs:109`) maps AgreementFlag true to occupied Negative, false to Positive, for both modes. Difference removes that side and Intersection retains it. This agrees with the unchanged exact Difference path keeping the positive normal side for true. The previous ccf review's suggested T-side numerical table was inverted and must not be reused: at z=1 in the 2x4x3 host, final T Difference is upper volume16 and T Intersection lower volume8; F reverses them.

The new off-centre native/browser witnesses check signed volume, z bounds and volume centroid, complementary volumes, and Difference against a separately executed unchanged exact source path. They distinguish side reversal, unlike the original mid-height fixture. The exact oracle is not a replacement geometry source for retained execution. Intersection remains new retained semantics where exact halfspace Intersection was unsupported.

Raw source plane, original coefficient provenance and actual local-metre plane remain distinct. Capture uses inverse(F)*(s*p) and transpose(F.linear)*n in the already selected actual input frame. The oblique rotated test checks signed plane evaluations at independent sample points; reflected/nonuniform tests require the physical Affine operation before capture and identity actual baked frame. Capture still requires a proper-rigid selected frame; it does not apply a rigid-only formula to an unbaked affine occurrence.

The runtime prerequisite's native/browser PlacedClip paths select an absolute replacement proper-rigid frame, validate the original live sealed clip, preserve handle/count/object, and append Placed lineage. Browser applies its common rigid gate after constructing the selected input; native gates the new frame directly. Added tests check replacement rather than composition, immutable original frame/handle, invalid reflected/scaled/NaN frame rejection and surviving independent descendants. These remain unrun.

## Remaining obligations and composition

Difference-Empty compatibility hold, polygonal/boxed halfspaces, Union, layers/openings, persistent face/texture fidelity and final product publication remain incomplete explicitly. No exact default kernel or numerical oracle is changed by these corrections. Node/control source or manifest validity cannot qualify SDK numerical behavior; the existing reported native copy/cutter/output validation failures remain unresolved by this processing patch.

Compose the narrow geometry/processing patch, preserving root499 AdmittedProgramReply Box+Reservation and root8828 shared retained-walk accounting/controller scopes. The two-field GeometryStep pattern remains compatible through the boxed wrapper's DerefMut; do not overwrite session/protocol files from the older isolated base. Parent runtime5468 already supplies PlacedClip; child0b765 is the same prerequisite and must not be applied again. Re-run complete assembled Rust/Clippy/browser/SDK qualification when authorized. No historical qualification transfers.

## Integrity

All21 entries of the child's final source-files.sha256 match immutable final Git blobs. The supplied implementation.patch SHA256 is exactly `f1540d0093b32f30b8f0ee2139c755de5e8557c6f286d69010bc2f4a119a14ba`. The companion `/tmp/ifclite-common-unary-20b-processing-review-hashes.json` records full commit, base,27 source/evidence Git blob and SHA256 identities, all manifest comparisons, and patch identity. Runtime prerequisite files are included separately as inspected dependencies, not misrepresented as part of the restricted source increment.
