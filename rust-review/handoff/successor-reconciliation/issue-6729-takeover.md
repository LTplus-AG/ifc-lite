# #6729 takeover — released from bc9e57fa

The user is transferring this issue to another agent. This thread stops #6729 investigation, capture dispatches and implementation. No production fix branch, uncommitted patch, active owned qualification job, reservation or pending automatic launcher is being handed over. The one hosted run this thread dispatched is completed/success. Repository checkout is clean. Existing evidence stays in place and can be read without repeating capture.

## Current issue and ownership

https://github.com/LTplus-AG/ifc-lite/issues/6729 remains OPEN/ready. The historical claim label is `claimed:session-b95d33a9`; that is another session's label and has not been removed or silently reassigned. The new agent should reconcile that claim with the user, rather than treating this support thread as the implementation owner. No agent was messaged or launched for this handoff.

Latest reporter evidence, October 18 01:07 UTC: https://github.com/LTplus-AG/ifc-lite/issues/6729#issuecomment-6244048966
Video: https://github.com/user-attachments/assets/cf0c2800-0831-4994-80fd-48d10b2e7ccf
The reporter explicitly says it still fails. This new video was not analyzed in this thread. The previous silence deadline does not justify closure.

## Start here

1. `reporter-6729-run39065763562/ASSESSMENT.md`: completed evidence and exact limits. This supersedes the older diagnosis's statement that hosted frames are missing.
2. `reporter-6729-run39065763562/`: original frames/report/provenance plus authentic reduced IFC, all retained locally. Run https://github.com/LTplus-AG/ifc-lite/actions/runs/39065763562; artifact12113656352 downloaded before expiry. Existing recorder merged in #7561; no second harness needed.
3. `reporter-6729-run39065763562/ray-witness-prep/PLAN.md`: optional prepared camera rays and payload-identity limitations. This is preparation, not a required new workflow or executed geometry oracle.
4. `6729-handoff-issue-readback-20261018.json`: full latest public issue discussion.

## What passed and what did not

Actual source b7507ec1c81853c76ed69ec2c42fbdf2bcd19c06, tree04cf35eea6519a73330c0ed64b119a91c7b91b5e. Source-built WASM SHA e85db56053f176e1dbf166ab92987f62bedb810bc786cfb535f1ccea0e84dfff.

Authentic reduced attachment `ifc-6729-out-visible-authentic.ifc`: 22,701 bytes, SHA cc6fbbf632c2779891e485c3297d437b1d8555448934b8c8b5a3cce5326553a2. It has 11 products/meshes and309 records, not the four products in an earlier issue comment. It is not identical to original23.74MB OUT.IFC; original nut GUID2oftvhExf8CXoy2ELYr$_9 is absent.

All36 functional frames, image hashes, selections and finite matrices passed; no recorded page/renderer/GPU errors. Adapter was SwiftShader, not a physical GPU. Inspection found no broad opaque leak in the selected static unselected views. Deliberate through-occluder selection silhouettes are not opaque occlusion failures. The bolt genuinely occupies the nut holes.

Occlusion verdict remains PENDING. Continuous orbit, near-contact ordering, original-model identity and physical-GPU behavior remain unproved. No full rendered triangle payload, per-pixel entity/depth buffers or independent ray oracle was captured. Current local WASM is not automatically identical to the historical captured payload.

## Concrete next step

Inspect the latest reporter video first and identify one actual failing pose/pixel or orbit transition using the existing authentic fixture/recorder. Reuse retained evidence where sufficient. For a suspected opaque-surface error, preserve all occluders and bind a nearest-surface/depth witness to the same actual payload and camera; keep deliberate selection silhouettes separate. Only if implicated, use an identical-payload diagnostic zero-nudge comparison. Do not start another broad capture/preparation program merely because one is proposed in old notes.

Leading hypothesis only: approximately0.632489mm maximum orthographic mesh-depth nudge may affect touching nuts and tiny bolt/hole clearances. No pixel-level causal proof exists; do not globally disable/reduce nudge or declare geometry repaired from this estimate. Existing #7117 selection-depth and coplanar controls must remain valid.

Ray implementation gotcha if reused:512x512 PNG is a center crop of908x843 canvas, origin(198,165), not a scaled viewport. Prepared588 rays validate camera reprojection only. Near plane can be negative. Geometry coordinates must not be rotated/scaled twice. Read PLAN.md before using them.

## Stopline

No fix, PR, occlusion acceptance or issue closure is claimed. No source/ref/claim-label/public issue changes were made for this handoff. This thread relinquishes its own support scope; old original artifacts and other session ownership remain preserved.
