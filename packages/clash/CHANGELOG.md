# @ifc-lite/clash

## 2.4.2

### Patch Changes

- Updated dependencies [[`f64353f`](https://github.com/LTplus-AG/ifc-lite/commit/f64353f10fb643a664a9f3f485ef009b1d2622f8), [`f30de14`](https://github.com/LTplus-AG/ifc-lite/commit/f30de14f957df133a3b6be8aa61fea934d76956a), [`3396e12`](https://github.com/LTplus-AG/ifc-lite/commit/3396e1241d8111c530b546659d006a35b6a5aed6)]:
  - @ifc-lite/bcf@5.0.0
  - @ifc-lite/wasm@10.1.2

## 2.4.1

### Patch Changes

- [#5724](https://github.com/LTplus-AG/ifc-lite/pull/5724) [`bf32c6a`](https://github.com/LTplus-AG/ifc-lite/commit/bf32c6a128d9ce1c8d9d2a0efcfe7f8754c3d01c) Thanks [@louistrue](https://github.com/louistrue)! - Clash depths between rotated boxes no longer drift with the model's distance from the origin.
  
  Box recognition, which lets the engine report an exact box-to-box penetration depth labelled as measured, rebuilt each box's centre from absolute world coordinates along axes taken from a single triangle each. Any error in those axes was multiplied by the element's distance from the origin. A 20 mm overlap between a 50 mm curtain-wall panel and a mullion, both rotated, read 23 mm (30 mm for a three-axis rotation) 123 m from the origin. From 1 km out it fell back to the AABB estimate (0.25 m / 1.38 m), and 10 km out the panel was not recognised as a box at all.
  
  Recognition now measures from a point on the element instead of the world origin. It takes each axis from the area-weighted normals of all the faces in that direction, makes the frame exactly orthonormal starting from the most precise faces, and sizes its tolerances from the float32 noise of the coordinates, capped at 0.1 rad so noise alone never certifies a non-box. The same 20 mm overlap now reads 20.0 mm and is certified at every placement up to 10 km, where the remaining 0.4 mm is the float32 resolution of the input itself. The TypeScript and Rust/WASM kernels change identically.
  
  On eight sample models the results at their own placement are unchanged.

- [#5764](https://github.com/LTplus-AG/ifc-lite/pull/5764) [`d376d2c`](https://github.com/LTplus-AG/ifc-lite/commit/d376d2c02ff35ea25efca5983626fa0b8073bc90) Thanks [@louistrue](https://github.com/louistrue)! - Flush contacts are no longer reported as hard clashes at an element dimension depending on where the model sits.
  
  When two elements' bounding boxes overlap but no triangles cross, the engine decides between a hard clash and a face touch by checking whether a probe point lies inside both solids. For elements that meet flush, the probe (the centre of the bounding-box overlap) lies on the shared face, where the inside/outside test is decided by float32 rounding. When it came out "inside", the pair was reported as a hard clash at the bounding-box overlap, e.g. 0.5 m for two footings or 0.3 m for two walls. Moving the whole model changed which pairs that happened to.
  
  A probe now counts only when it is farther from each surface than the pair's own depth floor along the probe's direction, the same floor that decides hard vs touch. The enclosed-solid check uses the same rule, so there is one definition of "clearly inside". On the sample models this turns 87 such pairs (12 on one model, 75 on another) from hard clashes into touches. In every one, no vertex of either element lies deeper inside the other than that floor. No new hard clashes appear, and the verdicts that change when a model is moved 10 km drop on every affected model (from 145 to 75 on the largest; to 0 on another).

- [#5721](https://github.com/LTplus-AG/ifc-lite/pull/5721) [`f947f8e`](https://github.com/LTplus-AG/ifc-lite/commit/f947f8e92e23535fe4e6ba21c2ebd2a854540ce5) Thanks [@louistrue](https://github.com/louistrue)! - Fix a genuine interpenetration being reported as a zero-depth touch when the two elements also share a coplanar face and sit off the world axes. A curtain-wall panel and a mullion authored to the same height overlap laterally by 20 mm while their tops and bottoms are flush; rotated off-axis, the pair read as `touch` at distance 0, and with touch reporting off the clash vanished from the report entirely. Tolerance made no difference, and every overlap from 0.5 mm to 20 mm behaved the same way.
  
  The cause was the scope of one of the three candidates the noise-floor gate tests. `crossingVertexPenetration` is a sampling probe, not a depth metric — its own documentation says so, and it underestimates by an amount that depends on tessellation. It exists to stop a *fabricated AABB estimate* promoting a flush contained pair to `hard`. But it was consulted even when the pair had a certified exact box depth, and there a mullion corner lying on a face the two boxes share bakes, through f32, a noise-width inside once the pair is rotated. The probe reported that as a sub-floor penetration and vetoed a depth the box MTD had already measured correctly.
  
  Mesh evidence now guards the estimate and only the estimate. Two boxes that are genuinely flush still report `touch` through the box-MTD term instead, so the flush case is unchanged.
- Updated dependencies [[`7fae2b8`](https://github.com/LTplus-AG/ifc-lite/commit/7fae2b8b2d6264a90af3235d95e0a4f6c257b9d7), [`bf32c6a`](https://github.com/LTplus-AG/ifc-lite/commit/bf32c6a128d9ce1c8d9d2a0efcfe7f8754c3d01c), [`d376d2c`](https://github.com/LTplus-AG/ifc-lite/commit/d376d2c02ff35ea25efca5983626fa0b8073bc90), [`975c430`](https://github.com/LTplus-AG/ifc-lite/commit/975c43086065cc7eaaf841d18f6f5ecbe626f0bd), [`b218ab4`](https://github.com/LTplus-AG/ifc-lite/commit/b218ab440fc09011c6bb1d39524525120e119cb1), [`7215c2a`](https://github.com/LTplus-AG/ifc-lite/commit/7215c2a9344ede37c90680e1eb2a6c2b70c0ee3d), [`e6ebbef`](https://github.com/LTplus-AG/ifc-lite/commit/e6ebbefde52670adbdb0c35bc19baed0453ca42f), [`5c02af8`](https://github.com/LTplus-AG/ifc-lite/commit/5c02af8b7fda4d2fe53f79d3f00b9d192fc664d9), [`6bf4181`](https://github.com/LTplus-AG/ifc-lite/commit/6bf418103e872f13666037ae4868e03468e3840c), [`d2cfb9e`](https://github.com/LTplus-AG/ifc-lite/commit/d2cfb9e66affc2674d6de5da44ecdc5d8a76b59e), [`477c1d5`](https://github.com/LTplus-AG/ifc-lite/commit/477c1d5ef5bb5057ff12f9d074270ec2359b39e1), [`db7f991`](https://github.com/LTplus-AG/ifc-lite/commit/db7f991eb63998c65389a28e7331ac984a5448ad)]:
  - @ifc-lite/bcf@4.2.1
  - @ifc-lite/wasm@10.1.1
  - @ifc-lite/parser@9.0.0
  - @ifc-lite/geometry@7.5.2
  - @ifc-lite/ifcx@4.2.1
  - @ifc-lite/query@2.5.1

## 2.4.0

### Minor Changes

- [#5691](https://github.com/LTplus-AG/ifc-lite/pull/5691) [`e682e6d`](https://github.com/LTplus-AG/ifc-lite/commit/e682e6da5f939aeca5940a65dd1cd338955e9c0f) Thanks [@louistrue](https://github.com/louistrue)! - Whether a reported clash counts as "touching" no longer depends on where the model sits in world space.
  
  `isTouching` (used by the viewer's "hide touching" filter) treats a `hard` clash as a contact when its depth is within a band. That band came from the largest absolute coordinate of the clash's bounds over all three axes, times 2^-22, so a model 10 km out along X gave a vertical contact about 2.4 mm of slack from the X coordinate alone. A genuine 1 mm overlap was listed as a clash at the origin and hidden as "touching" 10 km away.
  
  Every `hard` clash now carries `depthFloor`: the float32 noise floor of its own depth along the direction that depth was measured, which is the same floor the engine classified it against (defined once in the shared clash-math source, identical in the TypeScript and Rust/WASM kernels). `isTouching` uses `max(TOUCHING_EPSILON, depthFloor)` as its default band, so reporting and classification follow one rule. An explicit `eps` still overrides it.
  
  `Clash.depthFloor` is a new optional field, set on every `hard` clash and absent on every other status. A clash without it — recorded before this release, rehydrated from BCF or JSON without it, or built by hand — keeps the previous band unchanged. The WASM `ClashRunResult` gains a `depthFloor` getter (NaN for non-hard records), and the Rust `ClashSession` gains `run_rule_with_depth_floors`; `run_rule` and `ClashRecord` are unchanged.

### Patch Changes

- Updated dependencies [[`e682e6d`](https://github.com/LTplus-AG/ifc-lite/commit/e682e6da5f939aeca5940a65dd1cd338955e9c0f), [`5cfc6ff`](https://github.com/LTplus-AG/ifc-lite/commit/5cfc6ffd905db7fb512bddf1ddfa392c2156bd09)]:
  - @ifc-lite/wasm@10.1.0

## 2.3.3

### Patch Changes

- [#5591](https://github.com/LTplus-AG/ifc-lite/pull/5591) [`223f4d7`](https://github.com/LTplus-AG/ifc-lite/commit/223f4d71f26d074ba949f77031dc24f559da34ca) Thanks [@louistrue](https://github.com/louistrue)! - The Hard/Touch threshold for clash depths no longer depends on where the model sits in world space.
  
  A penetration depth at or below the f32 noise of the coordinates it was measured from is reported as a touch, not a hard clash. That floor used to be the largest absolute coordinate of the pair over all three axes times 2^-22, so a model 10 km out along X handed a vertical (Z-direction) contact about 2.4 mm of slack derived entirely from the irrelevant X magnitude. A genuine 2 mm overlap was a hard clash at the origin and a touch 10 km away, and near the origin the largest coordinate on any axis still set the threshold for contacts that have no component along it.
  
  Each depth candidate (the box-to-box penetration, the AABB estimate, and the crossing-vertex evidence for contained pairs) now carries the direction it was measured along, and is tested against the pair's per-axis noise projected onto that direction. The per-axis noise has two terms, both scaled by 2^-22: the axis's own coordinate magnitude (`max(1, |c|)`, the same rule as the triangle contact band), and the two elements' own sizes (each AABB's largest extent, summed), since placement and tessellation rounding grows with the element's size on every axis. The size term does not change under translation. The rule is defined once in the shared clash-math source, so the TypeScript and Rust kernels use the same floor.
  
  Measured on eight sample models: no pair becomes a new hard clash at the models' own placement, 15 hard clashes of 1.9 to 6 micrometres become touches, and the verdicts that change when the whole model is moved 1 km or 10 km along X drop on three of the models (none increase).

- [#5564](https://github.com/LTplus-AG/ifc-lite/pull/5564) [`0576221`](https://github.com/LTplus-AG/ifc-lite/commit/0576221cbd57276bce8da8d709045e2ae398a0df) Thanks [@louistrue](https://github.com/louistrue)! - Clash detection no longer reports flush and coplanar contacts as hard clashes because f32 rounding pushed two coincident surfaces a ULP through each other, and the verdict for such a pair no longer depends on where the model sits in world space.
  
  The triangle-triangle test both kernels share decided "touching" on an exact floating-point tie: a separating axis counted only if one triangle's projection ended at or before the other's began. Vertices reach the clash kernel as f32, so two surfaces authored flush land on the same or on adjacent f32 values, and which one a rigid translation of the model decides. One ULP either way turned a contact into a crossing, and a crossing sent the pair to the depth path, where it could come out as a hard clash at an AABB estimate the size of an element. The same tie decided every coplanar pair: for two coplanar triangles all the axes the test had are the shared normal, so it could not see an in-plane gap at all — a 20 mm clearance between a rotated panel and mullion was reported as a 1.38 m hard clash at the origin.
  
  Overlap within the f32 quantisation band of the tested axis now counts as contact. The band is per coordinate axis (`max(1, |c|) * 2^-22`, the scale the precision floor already uses) and projected onto each tested axis, so a coordinate axis orthogonal to it contributes nothing however far from the origin the model is. The edge-edge axis cutoff is now relative to the edge lengths, so axes between short edges are no longer all discarded below ~1 mm.
  
  On the buildingSMART Infra-Bridge sample this moves 48 of the 50 CLI-default hard clashes to touch (each measured at a mesh distance of at most 1.4e-6 m); no pair appears or disappears. A genuine penetration larger than the f32 resolution of its own coordinates is still reported as hard.
- Updated dependencies [[`223f4d7`](https://github.com/LTplus-AG/ifc-lite/commit/223f4d71f26d074ba949f77031dc24f559da34ca), [`0576221`](https://github.com/LTplus-AG/ifc-lite/commit/0576221cbd57276bce8da8d709045e2ae398a0df), [`0f5d174`](https://github.com/LTplus-AG/ifc-lite/commit/0f5d174d2fb726536d1a3a30c7e5415603db72c0), [`69dceea`](https://github.com/LTplus-AG/ifc-lite/commit/69dceeac3743944ad476e4338d38712f5cd1f12d), [`579b759`](https://github.com/LTplus-AG/ifc-lite/commit/579b7590bfe79cad5689cc89ab8082f95b5d6ea3)]:
  - @ifc-lite/wasm@10.0.1
  - @ifc-lite/parser@8.2.0

## 2.3.2

### Patch Changes

- [#5272](https://github.com/LTplus-AG/ifc-lite/pull/5272) [`bc22259`](https://github.com/LTplus-AG/ifc-lite/commit/bc222597e04bfa46d8fc331913615ec72d25bc64) Thanks [@louistrue](https://github.com/louistrue)! - Fix a cross-group broad-phase dedup that could silently drop a real clash, order-dependently, when one entity spans several geometry sub-prims sharing a durable key (common in IFC5/USD). The broad phase now hands every candidate submesh pair to the narrow phase; identity-level dedup happens once, after the narrow phase has decided each submesh's verdict, keeping the more severe result.

- [#5363](https://github.com/LTplus-AG/ifc-lite/pull/5363) [`32ac1f9`](https://github.com/LTplus-AG/ifc-lite/commit/32ac1f9846a5703c63ea859e5aeaf224f164db0c) Thanks [@louistrue](https://github.com/louistrue)! - Fix a clash rule whose B side matches nothing running as a self-clash of A on the WASM backend. A rule that named a B side (by `b` selector or by `membersB`) which resolved to zero elements reported A-vs-A pairs instead of no clashes; on an MEP-only model a "pipes vs building elements" rule returned 1,892 pipe-vs-pipe false positives. The TS backend was already correct, so the two backends disagreed.
  
  The cause was an ambiguous kernel contract rather than a missing check: `ClashSession::run_rule` encoded "self-clash" as an *empty* `group_b`, so "the caller named no B side" and "the caller named a B side that matched nothing" arrived as the same call. The orchestrator had the distinction (`number[] | null`) and carried it correctly all the way to the FFI boundary, where marshalling flattened both to a zero-length array.
  
  Self-clash is now an explicit absence: `group_b` is `Option<&[u32]>` in Rust and a nullable `Uint32Array` on the `ClashSession.runRule` binding. `None`/omitted is a self-clash; `Some`, **including an empty array**, is a two-sided rule. This also fixes a latent second instance of the same conflation, where a two-sided rule whose B indices were all out of range was filtered down to an empty list and became a self-clash.
  
  `@ifc-lite/clash` users are unaffected except that the bug is gone — `WasmClashEngine` and the `ClashRule` type are unchanged, and omitting `b` is still how you ask for a self-clash.
  
  **Breaking for direct `@ifc-lite/wasm` consumers only:** `ClashSession.runRule(groupA, groupB, …)` previously treated an empty `groupB` as a request for a self-clash. It now treats it as a B side with no members, which yields no clashes. Callers relying on the old encoding must pass `undefined` (or `null`) for `groupB` instead of an empty `Uint32Array`.

- [#5404](https://github.com/LTplus-AG/ifc-lite/pull/5404) [`0ddc31a`](https://github.com/LTplus-AG/ifc-lite/commit/0ddc31a0d4f321e4f4f43dd3e95572972c7937bb) Thanks [@louistrue](https://github.com/louistrue)! - Fix two origin-dependent defects in the OBB clash path that made flush and coplanar contacts classify differently depending on where the model sits in world space, and made a zero-volume contact report a penetration depth the size of the contact face.
  
  **A flush contact reported the shared face's extent as its depth.** `obbPenetrationDepth` treats an axis whose overlap falls inside its own noise band as inconclusive — correctly declining to let it separate the pair, but also dropping it from the depth minimum entirely. For two boxes in flush face contact the contact-normal axis *is* the minimising axis, so deleting it handed the minimum-translation distance to the next-smallest candidate: a 0.05 m curtain-wall panel resting against a mullion reported 0.85 m of penetration. An unresolvable axis now contributes a depth candidate of zero instead of none. "Each remaining axis is a valid upper bound, so the result stays conservative" holds for the boolean verdict and not for the depth, where deleting the minimising axis can only over-report.
  
  **A box stopped being recognised as a box when it was translated.** `detectObb` required its three face-normal families to be mutually perpendicular to within an absolute `OBB_EPS = 1e-6`. Those normals are computed from vertices that arrive as f32, so their direction error grows with coordinate magnitude and shrinks with feature size. For a 0.05 m thick rotated panel the worst `|dot|` between two genuinely perpendicular faces measures 2.25e-7 at the origin, 1.19e-6 at 7.4 m and 2.67e-4 at 1 km — so beyond a few metres a perfect box was rejected, and the pair silently fell off the measured-OBB path onto the coarser AABB estimate. The tolerance is now derived from the triangle's own conditioning (`coordErr * (|e1| + |e2|) / |e1 x e2|`), with `OBB_EPS` retained as a floor so geometry at the origin is judged exactly as strictly as before.
  
  Both fixes land in the TypeScript and Rust kernels together, which the differential suite requires.
  
  This does not eliminate every origin dependence: element vertices and AABBs still cross the WASM boundary as f32, so a rigid translation still re-quantises them. That is a separate, known limitation, reported alongside these two defects.
- Updated dependencies [[`2523acc`](https://github.com/LTplus-AG/ifc-lite/commit/2523acc5881252316439de2f69f7fab4266d559f), [`5909977`](https://github.com/LTplus-AG/ifc-lite/commit/5909977e0631cc242c421b5ded6c887acadd92ba), [`77f5e16`](https://github.com/LTplus-AG/ifc-lite/commit/77f5e16e939aac5d28301c56a29c04472aa90792), [`610c3a1`](https://github.com/LTplus-AG/ifc-lite/commit/610c3a1d60c76850c2d2cc839e176f97ec0e2ca6), [`8d45322`](https://github.com/LTplus-AG/ifc-lite/commit/8d45322f544ba1c3a6352303dfb048cc5d3836a6), [`5e79d7e`](https://github.com/LTplus-AG/ifc-lite/commit/5e79d7eb6837e238060dde19fa0b4933b832c1a7), [`32ac1f9`](https://github.com/LTplus-AG/ifc-lite/commit/32ac1f9846a5703c63ea859e5aeaf224f164db0c), [`c8fcbfb`](https://github.com/LTplus-AG/ifc-lite/commit/c8fcbfbfcc8e45526ef93c84ee8a254df586c10b), [`45ddd91`](https://github.com/LTplus-AG/ifc-lite/commit/45ddd91d1cee1c261ca5f1b1d0087fb2e070690f), [`dabc489`](https://github.com/LTplus-AG/ifc-lite/commit/dabc48987aca1392685218dd31641f8dbadf9590), [`60f70f9`](https://github.com/LTplus-AG/ifc-lite/commit/60f70f93c9cdf9948f1a7325efb1e157a09d3a60), [`7e5eb9e`](https://github.com/LTplus-AG/ifc-lite/commit/7e5eb9eb9631bceeefd5f03e6c18ac4cc7e35876), [`3166183`](https://github.com/LTplus-AG/ifc-lite/commit/31661831c8137f31aa6c3b0da286832ed6e16a7b), [`f942fb6`](https://github.com/LTplus-AG/ifc-lite/commit/f942fb6c48ac9be1464e49fd963340835a72945d), [`87d62bc`](https://github.com/LTplus-AG/ifc-lite/commit/87d62bca61704029b92882f2dd280dd497a77bd7), [`be636b4`](https://github.com/LTplus-AG/ifc-lite/commit/be636b414c11e7c5b77c2b98d0e916822ac39d09), [`58691b3`](https://github.com/LTplus-AG/ifc-lite/commit/58691b362d67ab87f666d76d6ee27e39d1ec45f9), [`5665917`](https://github.com/LTplus-AG/ifc-lite/commit/566591746eead289fcc5aa60258ef96b30366456), [`253cc3e`](https://github.com/LTplus-AG/ifc-lite/commit/253cc3e96ff001b3514f182a61b1be70f6a89fa5), [`becc9dc`](https://github.com/LTplus-AG/ifc-lite/commit/becc9dc4bd33267dbe8522f788fb8936dd349b70), [`0d9cbc0`](https://github.com/LTplus-AG/ifc-lite/commit/0d9cbc0072baa634923623c6772500d57a63f412), [`6314cbe`](https://github.com/LTplus-AG/ifc-lite/commit/6314cbed245efb39552487307be55b6884fd0b97), [`e6f46cb`](https://github.com/LTplus-AG/ifc-lite/commit/e6f46cbaf7d2ea515296f40497556b2b31bc5bd2), [`76d1119`](https://github.com/LTplus-AG/ifc-lite/commit/76d1119fb1573ef81f50d03c04026be3c83674ce), [`897eb6c`](https://github.com/LTplus-AG/ifc-lite/commit/897eb6c15342ad20a032b40fcb803559bf1a10f7), [`177f6d1`](https://github.com/LTplus-AG/ifc-lite/commit/177f6d18decd296ab6c25e7ec1d8200e461ceda0), [`4175a1e`](https://github.com/LTplus-AG/ifc-lite/commit/4175a1e0e8b055de2a5c58288a87b84c3c85c610)]:
  - @ifc-lite/wasm@10.0.0
  - @ifc-lite/bcf@4.2.0
  - @ifc-lite/geometry@7.5.1
  - @ifc-lite/spatial@1.15.0
  - @ifc-lite/parser@8.1.0
  - @ifc-lite/ifcx@4.2.0

## 2.3.1

### Patch Changes

- Updated dependencies [[`faadbb4`](https://github.com/LTplus-AG/ifc-lite/commit/faadbb409bc67bb5ace32757db050dd0ed83814f), [`873a648`](https://github.com/LTplus-AG/ifc-lite/commit/873a6481af34f1a494e9667ab1f77c3328125077), [`531246a`](https://github.com/LTplus-AG/ifc-lite/commit/531246a1a9f53ea6b66f7f1d140c7df268adc242), [`d38af5a`](https://github.com/LTplus-AG/ifc-lite/commit/d38af5afd36f12329fe6f33bf905d28fca65ba43), [`0100a54`](https://github.com/LTplus-AG/ifc-lite/commit/0100a544d0446d2f19b5f76f37d6dc45d31da837), [`dce19f5`](https://github.com/LTplus-AG/ifc-lite/commit/dce19f57399b9e75901fa5c4283adf781681301e), [`0e8a421`](https://github.com/LTplus-AG/ifc-lite/commit/0e8a4217514dcfacc7c488a230de244288428e1b), [`86dafce`](https://github.com/LTplus-AG/ifc-lite/commit/86dafced6e166889514a8514a23419659d0e7ce6), [`e2ca87d`](https://github.com/LTplus-AG/ifc-lite/commit/e2ca87d9b8f25be2ffeabd5843cbadc4154471c0), [`e1ace4f`](https://github.com/LTplus-AG/ifc-lite/commit/e1ace4f05a45a252d502bf72a506336185d2b157), [`ab8380e`](https://github.com/LTplus-AG/ifc-lite/commit/ab8380e6b9edf1ca1f05abf343ae6040ac8aee77), [`bab4e30`](https://github.com/LTplus-AG/ifc-lite/commit/bab4e30f438ac0bb585ea00a62a1a98a8221bede), [`794986e`](https://github.com/LTplus-AG/ifc-lite/commit/794986e8fa5acec057429b49302274ac8046eefe), [`24b2416`](https://github.com/LTplus-AG/ifc-lite/commit/24b24167e7213ed8f8c8d92211ec38c7221b9a11), [`65ea107`](https://github.com/LTplus-AG/ifc-lite/commit/65ea107b83e3d543b410721c74195562ca50bcca), [`ec114fe`](https://github.com/LTplus-AG/ifc-lite/commit/ec114fefabfd1b3a23d6a25545610652db6c5342), [`19af4c9`](https://github.com/LTplus-AG/ifc-lite/commit/19af4c9b5529a9052daf8a023ebe4e5144b9db2f), [`6e283f0`](https://github.com/LTplus-AG/ifc-lite/commit/6e283f0fb187195aae76097dd4ee1660a20ae325), [`3a47a0c`](https://github.com/LTplus-AG/ifc-lite/commit/3a47a0c2bb70966741882f8a0bae996823b9881f), [`e211790`](https://github.com/LTplus-AG/ifc-lite/commit/e211790ff4d7070d908fb519652158089652dd9c), [`50c23d4`](https://github.com/LTplus-AG/ifc-lite/commit/50c23d4321252a2fafff41e085e64e351c2cdb31)]:
  - @ifc-lite/wasm@9.2.0
  - @ifc-lite/query@2.5.0
  - @ifc-lite/parser@8.0.0
  - @ifc-lite/geometry@7.4.0
  - @ifc-lite/ifcx@4.1.2

## 2.3.0

### Minor Changes

- [#4872](https://github.com/LTplus-AG/ifc-lite/pull/4872) [`1cc533f`](https://github.com/LTplus-AG/ifc-lite/commit/1cc533f5ca326a8d574ca5e870dfdafec7df32d0) Thanks [@louistrue](https://github.com/louistrue)! - BCF viewpoints are now written and read in IFC world coordinates ([#4806](https://github.com/LTplus-AG/ifc-lite/issues/4806)). The viewer captured the camera, section plane and clash/IDS framing cameras in its origin-shifted render frame, so for a georeferenced model BIMcollab, usBIM and other BCF tools put the camera kilometres from the building, and imported cameras landed off-model the same way. `@ifc-lite/bcf` adds `translateViewpoint`, and `createBCFFromClashResult` accepts a `worldOffset`. Viewpoints written by earlier ifc-lite versions still open in place. Topics and viewpoints captured from the BCF panel while a clash is focused now carry the clashing pair as found objects and colouring, and the Clash panel's topic records its source-file header.

### Patch Changes

- [#4880](https://github.com/LTplus-AG/ifc-lite/pull/4880) [`35c0517`](https://github.com/LTplus-AG/ifc-lite/commit/35c0517d9779297704979131f451a4ae704bf744) Thanks [@louistrue](https://github.com/louistrue)! - BCF viewpoints are written in IFC world coordinates outside the viewer too ([#4879](https://github.com/LTplus-AG/ifc-lite/issues/4879)). `ifc-lite clash --bcf`, the MCP playground's `clash_bcf_export` and `bim.bcf.createViewpoint({ camera: bim.viewer.getCamera() })` wrote render-frame (origin-shifted, RTC-local) cameras, so other BCF tools put the camera hundreds of kilometres from a georeferenced building. A new `@ifc-lite/geometry/world-frame` entry point holds the one render frame <-> world conversion (`renderFrameWorldOffset`, `totalYupOffset`, `ifcToViewerAxes`, `viewerToIfcAxes`, `federationFrameInfo`), which the viewer, CLI, playground and SDK all use. `@ifc-lite/bcf` adds `viewpointFromWorld`, the inverse of `translateViewpoint` that keeps viewpoints written by ifc-lite before [#4806](https://github.com/LTplus-AG/ifc-lite/issues/4806) in place. In the SDK, `ViewerBackendMethods` gains an optional `getRenderFrameOffset()`; when a backend provides it (the viewer does), `bim.bcf.createViewpoint()` adds it and `bim.bcf.extractViewpointState()` subtracts it, so viewpoints are world coordinates and extracted cameras are ready for `bim.viewer.setCamera()`. Backends without it, and `new BCFNamespace()` with no backend, behave as before.
- Updated dependencies [[`1cc533f`](https://github.com/LTplus-AG/ifc-lite/commit/1cc533f5ca326a8d574ca5e870dfdafec7df32d0), [`35c0517`](https://github.com/LTplus-AG/ifc-lite/commit/35c0517d9779297704979131f451a4ae704bf744), [`e43c455`](https://github.com/LTplus-AG/ifc-lite/commit/e43c455711d4070b530436413db948fedcc34053), [`20bff7c`](https://github.com/LTplus-AG/ifc-lite/commit/20bff7c4069d267aa2662266b6213c3b2b406753)]:
  - @ifc-lite/bcf@4.1.0
  - @ifc-lite/geometry@7.2.0
  - @ifc-lite/parser@7.0.0
  - @ifc-lite/query@2.4.1

## 2.2.1

### Patch Changes

- Updated dependencies [[`d03e3ce`](https://github.com/LTplus-AG/ifc-lite/commit/d03e3ce4a01dffb60d8951a3ac13f17db37c3415), [`b1a22d7`](https://github.com/LTplus-AG/ifc-lite/commit/b1a22d721e4873883badbdb637630ea0ff88ea82), [`aef7203`](https://github.com/LTplus-AG/ifc-lite/commit/aef7203665f5374f2e867aa4bd43f26ef517c578), [`2343871`](https://github.com/LTplus-AG/ifc-lite/commit/2343871ceed4f42503e770c0a4e593e8827e9f91), [`5f3a915`](https://github.com/LTplus-AG/ifc-lite/commit/5f3a915bc061d4155fb80a6f195b845f4a147a6b), [`8d6df23`](https://github.com/LTplus-AG/ifc-lite/commit/8d6df23e670fbdd771643631d8960db6af99c6da), [`d731f16`](https://github.com/LTplus-AG/ifc-lite/commit/d731f16988996bcba5f5ef01283cdf1c8ab041ba), [`b5920f3`](https://github.com/LTplus-AG/ifc-lite/commit/b5920f316c6dd27030f8b2390deb803a0b9deef8), [`74ba2f2`](https://github.com/LTplus-AG/ifc-lite/commit/74ba2f24e664b37b96e871620fbfdbab653042f3), [`bb42608`](https://github.com/LTplus-AG/ifc-lite/commit/bb426086f8a3e07d1035f2baa3be973c41cba3e0), [`c53b946`](https://github.com/LTplus-AG/ifc-lite/commit/c53b946b5411d613fb5316f48fd03949cf656f75), [`a1b2b77`](https://github.com/LTplus-AG/ifc-lite/commit/a1b2b77d7d3de6878d14e73d888e04b50295a5e2), [`b4bc7df`](https://github.com/LTplus-AG/ifc-lite/commit/b4bc7df25e9cdcd6c46f4affd289c0b3da7829fa), [`9f32c63`](https://github.com/LTplus-AG/ifc-lite/commit/9f32c63083c9341871adac1d645c533c7afcac87), [`a2bc270`](https://github.com/LTplus-AG/ifc-lite/commit/a2bc270fb652466f4bd30511aa560997637ee83b), [`eb1b2b1`](https://github.com/LTplus-AG/ifc-lite/commit/eb1b2b1704d0ad5c8a0ee546871e8a266eb53955), [`4091265`](https://github.com/LTplus-AG/ifc-lite/commit/4091265e59279c87444d13f1d25537c00a430797), [`ec446fd`](https://github.com/LTplus-AG/ifc-lite/commit/ec446fd10b5e09724d88be75400119c1456afe6a), [`5ae670d`](https://github.com/LTplus-AG/ifc-lite/commit/5ae670d9701623b98414aafbedc3e8606db9bfa3), [`bbedaf6`](https://github.com/LTplus-AG/ifc-lite/commit/bbedaf629c635e102a3f65e2f7ba3feb77300d98), [`5a82260`](https://github.com/LTplus-AG/ifc-lite/commit/5a82260e3e0bf686851e724b24dbfa05d11d9c7c), [`6d8ebeb`](https://github.com/LTplus-AG/ifc-lite/commit/6d8ebebb7cd8722534ff1ad7817cf7a7d0191aaf), [`9b9f2df`](https://github.com/LTplus-AG/ifc-lite/commit/9b9f2df47e0b1192fe033ca36021499af532220b), [`a4e04e7`](https://github.com/LTplus-AG/ifc-lite/commit/a4e04e7868d6950e0139145319265788699d0afd), [`1f0f2ad`](https://github.com/LTplus-AG/ifc-lite/commit/1f0f2ad8fd3476cb705b0d32e00d07f874705088), [`c3492d1`](https://github.com/LTplus-AG/ifc-lite/commit/c3492d188d9353778dcb62e491cc8b1987d93767), [`7f31b01`](https://github.com/LTplus-AG/ifc-lite/commit/7f31b014f917ac038a316867673528810d9ba46a), [`9df0f93`](https://github.com/LTplus-AG/ifc-lite/commit/9df0f936e291c509c5914a8418535b1dae505517), [`2ecf0f0`](https://github.com/LTplus-AG/ifc-lite/commit/2ecf0f096d0f2d6079963040d3293e5964785486), [`be2fed0`](https://github.com/LTplus-AG/ifc-lite/commit/be2fed0945e7dff83e3fb5d9ba810f0b5a6339a7), [`56cc096`](https://github.com/LTplus-AG/ifc-lite/commit/56cc09672219d33e094b81d419d360ca3ec6e26e), [`478b5fb`](https://github.com/LTplus-AG/ifc-lite/commit/478b5fba37108dd0cf19cd2f71d71158e204f42f), [`6f5e74b`](https://github.com/LTplus-AG/ifc-lite/commit/6f5e74b028d4e8a2b94b05ead18163dd0c46ce9a), [`4986957`](https://github.com/LTplus-AG/ifc-lite/commit/4986957c383b88616f3807ee5fe27d41fb0380f4), [`be2fed0`](https://github.com/LTplus-AG/ifc-lite/commit/be2fed0945e7dff83e3fb5d9ba810f0b5a6339a7)]:
  - @ifc-lite/wasm@9.0.0
  - @ifc-lite/parser@6.4.0
  - @ifc-lite/geometry@7.0.0
  - @ifc-lite/query@2.3.4
  - @ifc-lite/spatial@1.14.19

## 2.2.0

### Minor Changes

- [#4565](https://github.com/LTplus-AG/ifc-lite/pull/4565) [`ec0fcfe`](https://github.com/LTplus-AG/ifc-lite/commit/ec0fcfe5cccec94b28fa1887822f0046b7522812) Thanks [@louistrue](https://github.com/louistrue)! - Export a clash run as a flat CSV table ([#3944](https://github.com/LTplus-AG/ifc-lite/issues/3944)). `@ifc-lite/clash` gains `clashTableRows` / `CLASH_TABLE_COLUMNS` / `bareIfcGuid`: one row per clash carrying both elements' bare IfcGUIDs (plus the adapter's durable keys), IFC types, names, models, storeys, the contact point, the signed distance and the coordinator's review status, so the table joins back to the model in Excel or Power BI. `@ifc-lite/export` gains `tableToCsv`, the one RFC 4180 writer for row-object tables (every cell through the shared formula-injection escaper; the zone-quantity CSV now uses it). The viewer's clash panel gets a **CSV** button next to the BCF export, and `ifc-lite clash` gets `--csv <out.csv>` (uncapped, unlike the `--json` display limit).

### Patch Changes

- Updated dependencies [[`0bd9521`](https://github.com/LTplus-AG/ifc-lite/commit/0bd9521554b616c101ab61425d6dc46beb3e904d), [`7562e5b`](https://github.com/LTplus-AG/ifc-lite/commit/7562e5b3f62ec57ca49cd412e35489bbf9e2ee6e), [`9a7710c`](https://github.com/LTplus-AG/ifc-lite/commit/9a7710c9c66e2285aeb215aec5600dfbce1b070e), [`624bfa3`](https://github.com/LTplus-AG/ifc-lite/commit/624bfa3b7d1d636a6142af984613eb5bd79c09b4), [`535055e`](https://github.com/LTplus-AG/ifc-lite/commit/535055ed47af49a22bc04788a1ff7e5755a54933), [`74aa364`](https://github.com/LTplus-AG/ifc-lite/commit/74aa364a14360f2af67a1902d7760b623d95c029), [`4eef3be`](https://github.com/LTplus-AG/ifc-lite/commit/4eef3be61bcc6fea16fb1a4376a7d7340ab5dc69), [`94074df`](https://github.com/LTplus-AG/ifc-lite/commit/94074df5c7e53557e45dd838ce22990c19544df8), [`ad4672f`](https://github.com/LTplus-AG/ifc-lite/commit/ad4672fc9007f8ac86076f123a1e6020b04af7b6), [`6295f8b`](https://github.com/LTplus-AG/ifc-lite/commit/6295f8b58ee5f85be27470463e4f333f5aa11b35), [`53003de`](https://github.com/LTplus-AG/ifc-lite/commit/53003de1e36a956b7f51e9dffc035218477d5d3c), [`5583362`](https://github.com/LTplus-AG/ifc-lite/commit/5583362ea8d7c988c84d44bf3b27c6c72fb6b798), [`0d8c5da`](https://github.com/LTplus-AG/ifc-lite/commit/0d8c5dac6175255d12ce758fe69c177af849dd03), [`6cc1b43`](https://github.com/LTplus-AG/ifc-lite/commit/6cc1b4362ed7ab2e909b81995bd7d4d99bc268d0), [`f7ea57f`](https://github.com/LTplus-AG/ifc-lite/commit/f7ea57f0555ca77695e28e41cfcfb0e9e7e3a2bb), [`a3aaaf0`](https://github.com/LTplus-AG/ifc-lite/commit/a3aaaf0832b0924237841075f37e76391ef200a2)]:
  - @ifc-lite/wasm@8.0.0
  - @ifc-lite/parser@6.2.0
  - @ifc-lite/geometry@6.0.0
  - @ifc-lite/ifcx@4.1.1
  - @ifc-lite/query@2.3.2
  - @ifc-lite/spatial@1.14.18

## 2.1.2

### Patch Changes

- [#4278](https://github.com/LTplus-AG/ifc-lite/pull/4278) [`dee75d8`](https://github.com/LTplus-AG/ifc-lite/commit/dee75d86d404e5a5ae15e71910704d970d2426a2) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `fromPositions` (`packages/clash/src/math/aabb.ts`) — the single choke point both the STEP and IFCX clash adapters funnel through when building `ClashElement.bounds` — now throws `NonFiniteAxisError` when every vertex is non-finite on some axis, instead of returning the box inverted (`min > max`) on that axis. The inverted box looked like a safe sentinel (the function's own doc claimed it was "rejected by `boxesTouch`"), but `boxesTouch` is only reached from the duplicates pass, not from the BVH broad phase (`@ifc-lite/spatial`, via `engine-ts/broad.ts`) that hard/soft rule-based clash detection uses: there, an inverted box fails every `min <= queryMax && max >= queryMin` check, so the element silently dropped out of every spatial query it should have participated in — including the one that would have found a genuine hard clash ([#4254](https://github.com/LTplus-AG/ifc-lite/issues/4254)).
  
  `elementsFromStep` (`adapters/step.ts`) and `elementsFromIfcx` (`adapters/ifcx.ts`) now catch `NonFiniteAxisError` per occurrence/entity, skip just that one (rather than aborting the whole clash run for one corrupt element among many), and emit a single `console.warn` naming the model and the count — the same shape as their existing `missingGlobalIds` warning — so a dropped element is loud and countable instead of silently invisible. Positions with only *some* non-finite coordinates are unaffected: the existing per-coordinate fold (the finite coordinate of a partly poisoned vertex still counts) is unchanged.
- Updated dependencies [[`9a271dc`](https://github.com/LTplus-AG/ifc-lite/commit/9a271dcb19dff2f9bca72fc3505ce5a71b3e800b), [`6fe4fc8`](https://github.com/LTplus-AG/ifc-lite/commit/6fe4fc8ddac8cbc18f3556fa7bfa778bf6115928), [`3fdbc2b`](https://github.com/LTplus-AG/ifc-lite/commit/3fdbc2b599fad2b1c43ffe014d2bab5f8b8c576c), [`3a1a322`](https://github.com/LTplus-AG/ifc-lite/commit/3a1a3229412b7822438fa5dba653f6c4e1bd239f), [`7f80d53`](https://github.com/LTplus-AG/ifc-lite/commit/7f80d53d2a2c158a322ec541ce064365f3f3ca8a), [`a53bd7f`](https://github.com/LTplus-AG/ifc-lite/commit/a53bd7fd4510b8d5c992eab26234084c5bb2387e), [`c952d49`](https://github.com/LTplus-AG/ifc-lite/commit/c952d497c424ec15b972d87b878b41bf0573460b), [`abda2d8`](https://github.com/LTplus-AG/ifc-lite/commit/abda2d8114ad17b0366f448100953d6e1972164c), [`c952d49`](https://github.com/LTplus-AG/ifc-lite/commit/c952d497c424ec15b972d87b878b41bf0573460b), [`511e488`](https://github.com/LTplus-AG/ifc-lite/commit/511e488a8de2b90f7d5f7663911873a92b3427c7), [`53c65fe`](https://github.com/LTplus-AG/ifc-lite/commit/53c65fecdac95b4c19a661be923c225d104a7be8), [`a53bd7f`](https://github.com/LTplus-AG/ifc-lite/commit/a53bd7fd4510b8d5c992eab26234084c5bb2387e)]:
  - @ifc-lite/bcf@4.0.0
  - @ifc-lite/wasm@7.0.0
  - @ifc-lite/parser@6.1.0
  - @ifc-lite/geometry@5.0.0
  - @ifc-lite/query@2.3.1
  - @ifc-lite/spatial@1.14.17

## 2.1.1

### Patch Changes

- [#4284](https://github.com/LTplus-AG/ifc-lite/pull/4284) [`997ba26`](https://github.com/LTplus-AG/ifc-lite/commit/997ba26adcbc170666fc086289fd21edb78813b1) Thanks [@BIMvoice](https://github.com/BIMvoice)! - `runClash` (`packages/clash/src/engine-ts/orchestrator.ts`) now throws `NonFiniteToleranceError` for a non-finite `settings.tolerance` or `rule.tolerance` (`NaN`, `+Infinity`, `-Infinity`) instead of running with it. A `NaN` tolerance — e.g. from `Number('')`/`Number('abc')` on a cleared UI input — used to sail through the `??` default substitution unchanged (`??` triggers only on `null`/`undefined`, never `NaN`), poison `Math.max(tolerance, rule.clearance ?? 0)`, poison the broad-phase AABB inflation, and make the BVH broad phase yield zero candidate pairs — silently. The run still reported `classifyRuleCoverage() === 'clean'`, because `ClashRuleCoverage.matchedA`/`matchedB` are selector-match counts taken before any geometry ran, so a caller reading "0 clashes" off that result would see a false all-clear over geometry the detector never actually compared ([#4244](https://github.com/LTplus-AG/ifc-lite/issues/4244)). A negative finite tolerance is unaffected: `Math.max(tolerance, clearance ?? 0)` keeps clamping it to at least the clearance (or zero), exactly as before.
  
  `ClashRuleCoverage` gains an optional `candidatesExamined` field: the broad-phase candidate pairs the geometry kernel actually narrow-phase tested for that rule (`RuleDetection.candidatesProcessed`), which was computed by the kernel but previously dropped before reaching the caller. This is a diagnostic, not a new coverage verdict — `classifyRuleCoverage`'s `'clean'`/`'partial'`/`'no-match'`/`'unknown'` outcomes are unchanged. Deliberately NOT reclassifying a rule that matched non-trivially on both sides but examined zero candidate pairs as suspicious: two selected groups that are genuinely farther apart than the rule's tolerance/clearance margin legitimately produce zero candidate pairs and a real `'clean'` result — that is the ordinary, correct outcome for disjoint geometry, and is common in a full discipline matrix run over a large model. Automatically downgrading it would misclassify that common, correct case, which is worse than the false-clean this fix removes. The validation above already closes the specific defect [#4244](https://github.com/LTplus-AG/ifc-lite/issues/4244) traces (a non-finite input reaching the broad phase); `candidatesExamined` hands a caller who wants to investigate a suspicious `'clean'` result the data to do so themselves.
- Updated dependencies [[`ced8bb4`](https://github.com/LTplus-AG/ifc-lite/commit/ced8bb46c368648bd54a1bab716d049143faa036), [`069020f`](https://github.com/LTplus-AG/ifc-lite/commit/069020f0ef51e8908c6fe86e6c3da011418d42d8), [`c5e583e`](https://github.com/LTplus-AG/ifc-lite/commit/c5e583e3c25349753dc415184359eba08db9c8ae), [`8ccd02d`](https://github.com/LTplus-AG/ifc-lite/commit/8ccd02dfa431b9194d7936b8966b5aabf4c34694), [`e776543`](https://github.com/LTplus-AG/ifc-lite/commit/e77654353eba7281429a2dbe7c7d973b3bbf0d9f), [`934d4e8`](https://github.com/LTplus-AG/ifc-lite/commit/934d4e819a0399b8f0b7d99b9c056e595e55cca5), [`b5cb19a`](https://github.com/LTplus-AG/ifc-lite/commit/b5cb19ae80610107f7b3b3914efa7234dfbe4999), [`32429a1`](https://github.com/LTplus-AG/ifc-lite/commit/32429a1e460fc4efee4c334037ac49a8738a5e0f), [`e844910`](https://github.com/LTplus-AG/ifc-lite/commit/e844910ce1b09db412687aa1a864649b8d77e4f6), [`cd0e214`](https://github.com/LTplus-AG/ifc-lite/commit/cd0e214cccbf81787a0b9c07735982cb101bad62), [`d4648ad`](https://github.com/LTplus-AG/ifc-lite/commit/d4648adb76466633733236087e527ff3e3780d81), [`b0700f2`](https://github.com/LTplus-AG/ifc-lite/commit/b0700f25434d1cf1ec5f7438a8e27c09188208ec), [`35fa016`](https://github.com/LTplus-AG/ifc-lite/commit/35fa016128b1c660ff822e6638d3274da68ebe09), [`12e69fe`](https://github.com/LTplus-AG/ifc-lite/commit/12e69feb363ea31fb2c3513436366b01c54251e9), [`83fb539`](https://github.com/LTplus-AG/ifc-lite/commit/83fb539395e3638eb4c72a5c0fb2c508a8746adb), [`f33ac74`](https://github.com/LTplus-AG/ifc-lite/commit/f33ac74dd0578792327f684ba5ca59f050458c65), [`85e0351`](https://github.com/LTplus-AG/ifc-lite/commit/85e0351c6bcbc350c404176e484320baa08a1366), [`6f0078b`](https://github.com/LTplus-AG/ifc-lite/commit/6f0078bc8ae697c9e6f91ae5b36546476b0fee5b), [`04d7b3b`](https://github.com/LTplus-AG/ifc-lite/commit/04d7b3ba0ab64ae9e97420aa8d5c56a536272724), [`be64c7c`](https://github.com/LTplus-AG/ifc-lite/commit/be64c7c3e0a8895869c459a798c2d1163f23c1b9), [`37f44ac`](https://github.com/LTplus-AG/ifc-lite/commit/37f44ac632f54322b89c7813723cad7e8e2b1ba5), [`c80a6cc`](https://github.com/LTplus-AG/ifc-lite/commit/c80a6cc2450252293761bf00174703e2bfd2483f), [`cabfd37`](https://github.com/LTplus-AG/ifc-lite/commit/cabfd3752d8dc221042990187669a5670be88df8), [`994cf95`](https://github.com/LTplus-AG/ifc-lite/commit/994cf950ab7a09613460f68f9ad16196b0bb64e1), [`a1d41d8`](https://github.com/LTplus-AG/ifc-lite/commit/a1d41d8187e564606d556e46c9a96a8022797234), [`5268ba3`](https://github.com/LTplus-AG/ifc-lite/commit/5268ba33f60577d0707ac5dcfdf3ab45a16e9bd0), [`68a6af8`](https://github.com/LTplus-AG/ifc-lite/commit/68a6af8c58f27895327ca0cf2b218ea15bd14050), [`f55a14e`](https://github.com/LTplus-AG/ifc-lite/commit/f55a14ec02d5a08e22bbd06dd960edc057aa9877), [`7427343`](https://github.com/LTplus-AG/ifc-lite/commit/742734300487f78df8192dc6fd4126615b63b966), [`2ab5f15`](https://github.com/LTplus-AG/ifc-lite/commit/2ab5f15a60f22cb1ed8f066ff2f41b37e4f76698), [`6ff9efa`](https://github.com/LTplus-AG/ifc-lite/commit/6ff9efaf184d466639516c2728024aa23a2f6b33), [`d39d9a4`](https://github.com/LTplus-AG/ifc-lite/commit/d39d9a499a3fbc81650bfab7562b6d89df4a53f8), [`6110c0d`](https://github.com/LTplus-AG/ifc-lite/commit/6110c0d6bb0c1a96c4da4c056389ebc4dfe26631), [`52532e0`](https://github.com/LTplus-AG/ifc-lite/commit/52532e01ed9513cd49144f935fd282c19158339d), [`8f8b017`](https://github.com/LTplus-AG/ifc-lite/commit/8f8b0179be76fea8cb7f21b34bb6408084e410af), [`a88027b`](https://github.com/LTplus-AG/ifc-lite/commit/a88027b9ae642da850a3515d8eef83d750b655b3), [`8198c44`](https://github.com/LTplus-AG/ifc-lite/commit/8198c44e0297657f7775a3ee6bd10855bd23c132), [`7934571`](https://github.com/LTplus-AG/ifc-lite/commit/7934571755febaae5287cc4a876bcf2c8b8b2463), [`d4e7b99`](https://github.com/LTplus-AG/ifc-lite/commit/d4e7b99baa4349f1ae096fc2f194e46a8049ccb9), [`be4fdb9`](https://github.com/LTplus-AG/ifc-lite/commit/be4fdb9ffe6995c74d3629887021c98b843beadb), [`227a93c`](https://github.com/LTplus-AG/ifc-lite/commit/227a93cd166376b76c9feaa74e7f7fad27f5c941), [`379852a`](https://github.com/LTplus-AG/ifc-lite/commit/379852a658bae039f312dcb8547629703891d2f9), [`ae85338`](https://github.com/LTplus-AG/ifc-lite/commit/ae8533851faa4fe9508d36cfb1a2ca99c240ec7b), [`a6976b9`](https://github.com/LTplus-AG/ifc-lite/commit/a6976b9da44d13157533372a8def23995fcfb93f), [`6138db1`](https://github.com/LTplus-AG/ifc-lite/commit/6138db1220bd148f8226c922255441a2047d2c6b)]:
  - @ifc-lite/parser@6.0.0
  - @ifc-lite/query@2.3.0
  - @ifc-lite/wasm@6.5.0
  - @ifc-lite/ifcx@4.1.0
  - @ifc-lite/geometry@4.4.0

## 2.1.0

### Minor Changes

- [#3947](https://github.com/LTplus-AG/ifc-lite/pull/3947) [`5d4140b`](https://github.com/LTplus-AG/ifc-lite/commit/5d4140b305aa3ef2c1d82e1def85095c8832bbed) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Compare a saved clash-run baseline against the current run and see which clashes are new, still open, or no longer detected ([#3928](https://github.com/LTplus-AG/ifc-lite/issues/3928)).
  
  `@ifc-lite/clash` already shipped `compareClashRuns`, the matching engine for diffing two clash runs by their durable `clashReviewKey`, but it had no viewer, CLI, or sandbox consumer. This adds one: a "Compare clash runs" dialog in the clash panel header lets a coordinator save the current result as a baseline and later compare a fresh run against it.
  
  A raw `compareClashRuns` diff is unsafe to show as-is: it cannot tell "genuinely fixed" apart from "we didn't actually re-check". A dropped rule, a rule whose selector now matches nothing, or a model no longer part of the comparison all make a clash vanish from the current run's results for reasons that have nothing to do with the model getting better. `@ifc-lite/clash` gains `compareClashRevisions`, which wraps `compareClashRuns` and reclassifies an unsafe `resolved` clash into a new `unretested` bucket, so a coordinator is told "unconfirmed" instead of a false "fixed". The viewer dialog surfaces the reason for every `unretested` clash instead of hiding it in a bucket count.
  
  The safety check works at per-element granularity, not just per-rule/per-model: a `resolved` clash is only trusted when BOTH of its elements are confirmed, by durable key, to still be matched by the SAME SIDE of the same rule in the current run (`ClashRuleCoverage.matchedKeysA`/`matchedKeysB`, new fields the engine now records alongside the existing match counts). Checking `matchedKeysA` and `matchedKeysB` separately, rather than as one combined set, matters when the two sides overlap (e.g. an element listed in both `membersA` and `membersB`): a clash's A-side element must still be matched on side A, and its B-side element still matched on side B — an element that only moved to the other side is not "still matched" for that clash. A self-clash rule (no `b` side at all) has just the one group, so its two elements are checked against that single set instead. This also catches a narrowed selector or re-scoped membership filter that drops just one previously-clashing element while the rule's overall coverage stays non-zero, and a durable key (e.g. GlobalId) that was re-minted between exports for the same physical element. Model identity for the missing-model check no longer collapses on a duplicate display name: two models sharing one name are told apart by how many still share it, not by simple set membership.
  
  The viewer's saved-baseline persistence now validates the stored shape (`result.clashes` must be an array) and its schema version before trusting it, instead of handing a structurally-thin corrupted value to the compare engine, which iterates `clashes` directly.
  
  New exports on `@ifc-lite/clash`: `compareClashRevisions`, `ClashRevisionSide`, `ClashRevisionComparison`, `ClashRevisionReasons`.

### Patch Changes

- Updated dependencies [[`af067e5`](https://github.com/LTplus-AG/ifc-lite/commit/af067e598e64cbc8265fdcd462ac9cb9727711a2), [`e1d807c`](https://github.com/LTplus-AG/ifc-lite/commit/e1d807cf4bf4f3bf25122fed4d7e3fde8296bf6d), [`09f9419`](https://github.com/LTplus-AG/ifc-lite/commit/09f941947666f567cd1fd6fd362041e048868434), [`6094e2f`](https://github.com/LTplus-AG/ifc-lite/commit/6094e2f16f27c80bc227f73bbdf634a770f17abc)]:
  - @ifc-lite/parser@5.1.0
  - @ifc-lite/wasm@6.3.0

## 2.0.0

### Major Changes

- [#3473](https://github.com/LTplus-AG/ifc-lite/pull/3473) [`56a0e01`](https://github.com/LTplus-AG/ifc-lite/commit/56a0e0112a22f58ac779534427781500c2256826) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `compareClashRuns` (clash revision lifecycle) reporting a still-open clash as resolved-then-added, instead of `persistent`, whenever the two runs come from separate model loads.
  
  `compareClashRuns` matched clashes between the "previous" and "next" run by the raw `clash.id`. `engine-ts/orchestrator.ts`'s `clashId()` folds `ClashElement.model` into that id (`${model} ${key}`), and `review.ts` documents `model` as an ephemeral per-load id assigned by the host app — which is exactly why `review.ts`'s own durable key, `clashReviewKey`, deliberately excludes it. Two loads of identical geometry (precisely the "model revision" scenario this module exists to diff) therefore produced two different `clash.id`s for the same real-world clash, so a clash that was still open on the next run was reported as `resolved` (from the previous run) and `added` (in the next run) instead of `persistent` — defeating the point of revision tracking and burying any genuinely new or resolved clash in spurious churn. Two runs inside one loaded session, where `model` never changes, matched correctly before and still do.
  
  `compareClashRuns` now matches by `clashReviewKey` (rule id + the two elements' durable keys, order-independent). That key is not unique within a run: dropping `model` is what makes it durable, but the engine treats `(model, key)` as element identity, and neither adapter model-scopes the key it produces (`adapters/ifcx.ts` uses the bare USD prim path, `adapters/step.ts` the bare IfcGUID — only its `syntheticKey` fallback folds in the model id). A federated run therefore holds several distinct clashes under one review key when the same wall hits `/Duct` in two loaded layers, and matching on key membership alone would collapse them, swallowing a resolved clash and reporting a genuinely new one as pre-existing. Occurrences are grouped per review key and paired instead. Equal `clash.id`s pair first, which covers every clash that survived without a re-load. Each leftover is then read against the `model` ids the other run actually clashed in: a leftover whose two elements both sit in models that still clash over there cannot be the same clash seen again, because it would have kept its id and paired, so it is reported as `resolved` or `added`. Only leftovers whose models the other run no longer shows — the re-load case — pair with each other, in run order, and any surplus becomes `added` or `resolved`.
  
  Those model ids are read off each run's own clashes, so a model that produced no clash at all in a run is invisible to that test and its leftovers count as re-loaded. The error there runs towards `persistent` and away from `added` and `resolved`: the churn-free reading, not a claim that something was fixed.
  
  Breaking for callers of `compareClashRuns`: the same two `ClashResult`s can now land in different buckets. The intended move is a clash that survives a re-load leaving `added` + `resolved` for `persistent`. Matching also counts occurrences now rather than testing id membership, so a run that repeats one `clash.id` (the engine does not produce that; a hand-built `ClashResult` can) is paired per occurrence instead of collapsing to a single membership test, which can put an occurrence into `added` or `resolved` that previously landed in neither. The output shape, the sort order, and the `persistent` bucket's "report the next run's `Clash`" behaviour are unchanged.

### Minor Changes

- [#3908](https://github.com/LTplus-AG/ifc-lite/pull/3908) [`c5da727`](https://github.com/LTplus-AG/ifc-lite/commit/c5da72799a1832d7040942fa621c50973896b7fd) Thanks [@louistrue](https://github.com/louistrue)! - Clash rules can define each side with the viewer's advanced filter, not just a type selector ([#3902](https://github.com/LTplus-AG/ifc-lite/issues/3902)).
  
  A clash rule's A and B sets were one type-name pattern each (`IfcDuct*|IfcPipe*`), which cannot say "external walls" or "elements whose Pset_Revit_Phase.Phase is Existing". Each side of a rule may now carry a filter: the same rule rows the search panel offers — IFC type, name, predefined type, storey, elevation, property, quantity, material, classification — combined with AND or OR, edited with the same row components. The set is resolved with the same evaluator the search panel runs (`evaluateFilterRulesFederated`), so the two cannot drift apart.
  
  `ClashRule` gains optional `membersA` / `membersB`: explicit `clashMemberKey(model, ref)` membership for a side, which replaces that side's selector when present. An empty list means the filter matched nothing and is deliberately distinct from an absent one, which still means "use the selector". A side with no filter, and every rule set saved before this, runs exactly as it did.
  
  New exports on `@ifc-lite/clash`: `clashMemberKey`, `clashMemberSet` and `inClashSet` build and read that membership, and `describeEmptyRuleSides` says which side of a rule matched nothing and whether it was defined by a selector or by a filter. `ClashRuleCoverage` gains `fromMembersA` / `fromMembersB` for the same reason, and `ClashResult.rulesRun` reports each rule without its resolved member lists — those are run state, not configuration.

### Patch Changes

- [#3856](https://github.com/LTplus-AG/ifc-lite/pull/3856) [`142b84c`](https://github.com/LTplus-AG/ifc-lite/commit/142b84c41036b749e7b64418a882424b9c386edb) Thanks [@louistrue](https://github.com/louistrue)! - Write the `DocumentReference/@Guid` that BCF 3.0 requires.
  
  2.1's markup.xsd leaves the attribute optional and 3.0's
  `DocumentReferenceAttributes` marks it `use="required"`, so a 3.0 topic
  carrying a document reference without one produced a `markup.bcf` that fails
  validation, and a viewer that rejects markup.bcf drops the topic entirely. A
  guid is now derived when the caller supplied none, and written back onto the
  reference so the in-memory project matches the file. A caller-supplied guid is
  kept, and BCF 2.1 output is unchanged.
  
  The guid is a pure function of the topic, the document and the position, so two
  exports of one unchanged project are byte-identical. `uuidFromSeed` moved from
  `@ifc-lite/clash` to `@ifc-lite/encoding` to make that sharing possible without
  a package cycle (`@ifc-lite/clash` depends on `@ifc-lite/bcf`); it is now
  exported from `@ifc-lite/encoding`, and `@ifc-lite/clash` re-exports it from its
  existing path, so no clash caller changes.

- [#3561](https://github.com/LTplus-AG/ifc-lite/pull/3561) [`b264887`](https://github.com/LTplus-AG/ifc-lite/commit/b26488758f481c489e7f596568adfe237dd444da) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `unionAabb` (`contact/aabb.ts`) to fold bounds with NaN-safe comparisons instead of `Math.min`/`Math.max`. `Bvh.build` (`contact/bvh.ts`) folds `unionAabb` bottom-up over every ancestor of a leaf, so a single degenerate (NaN-vertexed) triangle — e.g. from corrupt mesh geometry — poisoned the aggregate bounds of every node above it, up to and including the tree root. `queryMeshCross` then treated the poisoned bounds as "no overlap" and pruned the whole subtree, silently dropping every other, valid triangle from contact-interface clustering (`contactClusters`) and minimum-distance queries (`minDistanceBetweenMeshes`). A NaN triangle is now simply excluded from the aggregate rather than poisoning it, matching `aabbFromPositions` in the same file and `compute_bounds` in `rust/clash/src/bvh.rs`.

- [#3855](https://github.com/LTplus-AG/ifc-lite/pull/3855) [`182215a`](https://github.com/LTplus-AG/ifc-lite/commit/182215a835c4beac6a776bcb4eb1d019cab9063e) Thanks [@louistrue](https://github.com/louistrue)! - Corrected the code samples on each package's npm landing page: the README fences are now typechecked against the package's real exports, so the snippets import what they call, declare the values they read, and no longer show removed options or renamed methods. Patch-bumping every package whose README changed so the corrections actually reach npmjs.com.
- Updated dependencies [[`b02da88`](https://github.com/LTplus-AG/ifc-lite/commit/b02da889d60f720f1b4a868b48be12a95027f6e6), [`142b84c`](https://github.com/LTplus-AG/ifc-lite/commit/142b84c41036b749e7b64418a882424b9c386edb), [`142b84c`](https://github.com/LTplus-AG/ifc-lite/commit/142b84c41036b749e7b64418a882424b9c386edb), [`3284390`](https://github.com/LTplus-AG/ifc-lite/commit/328439014322dafaecb1bc930cd66ce5192c3c74), [`bbcb476`](https://github.com/LTplus-AG/ifc-lite/commit/bbcb476209a96b3c8a97f11751f4540cdaf41919), [`bbcb476`](https://github.com/LTplus-AG/ifc-lite/commit/bbcb476209a96b3c8a97f11751f4540cdaf41919), [`bbcb476`](https://github.com/LTplus-AG/ifc-lite/commit/bbcb476209a96b3c8a97f11751f4540cdaf41919), [`1d51937`](https://github.com/LTplus-AG/ifc-lite/commit/1d519376392e405645166761cc537bfbed9083cf), [`18e4de8`](https://github.com/LTplus-AG/ifc-lite/commit/18e4de865884d3126f478a9081cf56178fefcd00), [`80398a9`](https://github.com/LTplus-AG/ifc-lite/commit/80398a944093e3607944c70803b82d64fc372cba), [`9e45546`](https://github.com/LTplus-AG/ifc-lite/commit/9e455460f81f4bd463ef65116cbd89000e5539f7), [`06f81fe`](https://github.com/LTplus-AG/ifc-lite/commit/06f81fe10ba35a5b8edc7848017017f1f4d045ea), [`3e117c2`](https://github.com/LTplus-AG/ifc-lite/commit/3e117c249e792362ee5ec7eb722cf400ee18940a), [`f283c62`](https://github.com/LTplus-AG/ifc-lite/commit/f283c62da53d672d590322edd3351e7b71724757), [`8904273`](https://github.com/LTplus-AG/ifc-lite/commit/890427360361fba5232bef614371fe69d9528e47), [`7b79a93`](https://github.com/LTplus-AG/ifc-lite/commit/7b79a93f80afe104ebe3e20ae742af26b48b21a2), [`82343f7`](https://github.com/LTplus-AG/ifc-lite/commit/82343f75dd2e6029946cbcd0990d3f8fd38a26ad), [`55b69fb`](https://github.com/LTplus-AG/ifc-lite/commit/55b69fbac09155f4cc9c8b2eecba17fd84067c32), [`59fae4c`](https://github.com/LTplus-AG/ifc-lite/commit/59fae4cb4c4841b27cbe26a618648407d74d2326), [`9f945d1`](https://github.com/LTplus-AG/ifc-lite/commit/9f945d1e2193cb27e5471f5272496b2791975ede), [`2b594d2`](https://github.com/LTplus-AG/ifc-lite/commit/2b594d20616f957f7ef949aa8563274e5373a95b), [`2b594d2`](https://github.com/LTplus-AG/ifc-lite/commit/2b594d20616f957f7ef949aa8563274e5373a95b), [`586fa29`](https://github.com/LTplus-AG/ifc-lite/commit/586fa292b69cdb3ba6e45764b4ff742b2fa7b9a9), [`10b45b5`](https://github.com/LTplus-AG/ifc-lite/commit/10b45b571e2c2832bd938bb2a89e6d85d80aed5d), [`3efe762`](https://github.com/LTplus-AG/ifc-lite/commit/3efe762a993897fc3ddc029a8de1e5914e27df3f), [`d08e420`](https://github.com/LTplus-AG/ifc-lite/commit/d08e420c9f39e9c0427aba47966cc6acf12642cc), [`05193c9`](https://github.com/LTplus-AG/ifc-lite/commit/05193c9a9fd878f70bd9d9007199166fee05872b), [`3d11231`](https://github.com/LTplus-AG/ifc-lite/commit/3d11231806fec3047c9ed32b9d095be3abe60c2f), [`140a6d8`](https://github.com/LTplus-AG/ifc-lite/commit/140a6d8541224341835c98028dc75e6a5ccd605d), [`7160b73`](https://github.com/LTplus-AG/ifc-lite/commit/7160b73d573e276e390f62c065b66eb80862c1c5), [`5297514`](https://github.com/LTplus-AG/ifc-lite/commit/52975142846390bb1eb12b723d53c0e275289a90), [`6aa2b76`](https://github.com/LTplus-AG/ifc-lite/commit/6aa2b76d4a988e7ee1fd6bcad7c46a41650704b3), [`1000dce`](https://github.com/LTplus-AG/ifc-lite/commit/1000dce72e9ec75c59848efefc1f709d01172e72), [`499ccf2`](https://github.com/LTplus-AG/ifc-lite/commit/499ccf2f97fe1e24728eb4eb99f895044c36f7b2), [`afb9725`](https://github.com/LTplus-AG/ifc-lite/commit/afb972525bb99e3056ccaa84ee7a78e0c7de81ef), [`2329b20`](https://github.com/LTplus-AG/ifc-lite/commit/2329b20506160171da97af7d4dd0cd76ab85f13f), [`cebcb21`](https://github.com/LTplus-AG/ifc-lite/commit/cebcb2133ef672e9199ee2f158578499d449d9e0), [`e986c81`](https://github.com/LTplus-AG/ifc-lite/commit/e986c81bf6d28fec57f1953fa53bf315dbd80a3a), [`8c181c9`](https://github.com/LTplus-AG/ifc-lite/commit/8c181c99f91964402ad352aead36d9619af5b427), [`6e48c4c`](https://github.com/LTplus-AG/ifc-lite/commit/6e48c4c5f441e8a42e4cc55440cf747ad8679f0a), [`8f08715`](https://github.com/LTplus-AG/ifc-lite/commit/8f087158a662a02c01a21dd2546fb863bb24e665), [`9b709c5`](https://github.com/LTplus-AG/ifc-lite/commit/9b709c51480fbabb68167aa4892f7e4c87b0e4e6), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`32b31bc`](https://github.com/LTplus-AG/ifc-lite/commit/32b31bc8501f04e110733289bde0389b9899bc76), [`62bb58f`](https://github.com/LTplus-AG/ifc-lite/commit/62bb58fc8364c27bcf8452ab8edbde26727f527c), [`ea81645`](https://github.com/LTplus-AG/ifc-lite/commit/ea81645f7cd47d9e62718a6687f9e780794c2aa2), [`74d76bb`](https://github.com/LTplus-AG/ifc-lite/commit/74d76bb52d03397734022855c9cbcd6bdef38632), [`96d8f41`](https://github.com/LTplus-AG/ifc-lite/commit/96d8f4126073250e079d7cdc8f77b409e70400e7), [`c6ffda4`](https://github.com/LTplus-AG/ifc-lite/commit/c6ffda4789099a45fafdb5fe237c33c6edd9884c), [`3b266b9`](https://github.com/LTplus-AG/ifc-lite/commit/3b266b99dac5e384c48a410df7074803b01ef20f), [`d2fb0e4`](https://github.com/LTplus-AG/ifc-lite/commit/d2fb0e4121ccd19f326837ea574b189ee2a5f6c8), [`456d189`](https://github.com/LTplus-AG/ifc-lite/commit/456d1898cdfdc1e31b145777b0f33bad203cc62a), [`b7efeac`](https://github.com/LTplus-AG/ifc-lite/commit/b7efeac2195908729d1bf571839e2607f43c8ff7), [`4475e58`](https://github.com/LTplus-AG/ifc-lite/commit/4475e583ea35def444fb6d7ba92410629bd89096), [`182215a`](https://github.com/LTplus-AG/ifc-lite/commit/182215a835c4beac6a776bcb4eb1d019cab9063e), [`f1a006a`](https://github.com/LTplus-AG/ifc-lite/commit/f1a006af952dd670c6486cdb4ef0e8e1e0e280d7), [`4475e58`](https://github.com/LTplus-AG/ifc-lite/commit/4475e583ea35def444fb6d7ba92410629bd89096), [`afa717b`](https://github.com/LTplus-AG/ifc-lite/commit/afa717bcf6041ad34085626fcfac321207ce4b81), [`6bd2550`](https://github.com/LTplus-AG/ifc-lite/commit/6bd25508dadd14fee97ee1f7393212cdcc086fdc), [`cb56282`](https://github.com/LTplus-AG/ifc-lite/commit/cb56282133a3349299665859b5507b739808d32e), [`d733175`](https://github.com/LTplus-AG/ifc-lite/commit/d733175d4ac2e8a2e94fc0bf9804d7bc03627cc1), [`fdac473`](https://github.com/LTplus-AG/ifc-lite/commit/fdac4734ce04758d2cd12b365f8b6de624713de6), [`902768e`](https://github.com/LTplus-AG/ifc-lite/commit/902768e138b595b26a47389bcea536f3f9e25b6d), [`ce8ca9f`](https://github.com/LTplus-AG/ifc-lite/commit/ce8ca9f3b8fd51ed89a9c21a275f00d63c240875), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`9368b2d`](https://github.com/LTplus-AG/ifc-lite/commit/9368b2dcdc8df61afe790e671de95317e0418c21), [`2c84b15`](https://github.com/LTplus-AG/ifc-lite/commit/2c84b15526456ad57ba93a77f669208174efbed3), [`4b043d4`](https://github.com/LTplus-AG/ifc-lite/commit/4b043d4e77345e77532c328ddd62d58c39b6bbe8), [`3cd1647`](https://github.com/LTplus-AG/ifc-lite/commit/3cd1647a2918ac27b903cb82bc797c2d2b288ac3), [`a1069f8`](https://github.com/LTplus-AG/ifc-lite/commit/a1069f8f096fcfc5771200a2748466096c3463d5), [`afb9725`](https://github.com/LTplus-AG/ifc-lite/commit/afb972525bb99e3056ccaa84ee7a78e0c7de81ef), [`b331b49`](https://github.com/LTplus-AG/ifc-lite/commit/b331b4921ff0927ee18bb78f00d2bb6e496219d8), [`cb9dad2`](https://github.com/LTplus-AG/ifc-lite/commit/cb9dad2df38f1796ab8cb6eefe881ad795876cc9), [`0b13e2d`](https://github.com/LTplus-AG/ifc-lite/commit/0b13e2d89b51608c2be3425ba2e5c95bfb8c0e5e), [`c4dafbf`](https://github.com/LTplus-AG/ifc-lite/commit/c4dafbf418810c519d49d5739bfedb2da41651b0), [`c3bdc8f`](https://github.com/LTplus-AG/ifc-lite/commit/c3bdc8fe55536a9b27adaa7ed92fb214c975fe2e), [`c3bdc8f`](https://github.com/LTplus-AG/ifc-lite/commit/c3bdc8fe55536a9b27adaa7ed92fb214c975fe2e), [`3460785`](https://github.com/LTplus-AG/ifc-lite/commit/3460785652f251f3161aa8dd6f1d247750df2715), [`80a0cd9`](https://github.com/LTplus-AG/ifc-lite/commit/80a0cd9b946a5ff1aa6ca214ddb427a5d1f5303c), [`b135862`](https://github.com/LTplus-AG/ifc-lite/commit/b1358623210867daba42ff56e97ff05733bff646), [`8368339`](https://github.com/LTplus-AG/ifc-lite/commit/83683393654d8c1b903f03b5c6e9e5ff111fdaf0), [`2edd144`](https://github.com/LTplus-AG/ifc-lite/commit/2edd14432999ceeed4c0bb0baf6b2000c1c5b041), [`2a2c73f`](https://github.com/LTplus-AG/ifc-lite/commit/2a2c73fc95044c5e6823f0dbc55f5e2c7a87a948), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`3ccb417`](https://github.com/LTplus-AG/ifc-lite/commit/3ccb4176f3a61a227bcfc302c3e0b1fb43a6f0ec), [`7eaed2a`](https://github.com/LTplus-AG/ifc-lite/commit/7eaed2a98a8cd60bd402c0a9d79940739eabb331), [`2213431`](https://github.com/LTplus-AG/ifc-lite/commit/22134312e50d7f2dbe5d45928740eef5f6ffa241), [`499ccf2`](https://github.com/LTplus-AG/ifc-lite/commit/499ccf2f97fe1e24728eb4eb99f895044c36f7b2), [`4475e58`](https://github.com/LTplus-AG/ifc-lite/commit/4475e583ea35def444fb6d7ba92410629bd89096), [`80a0cd9`](https://github.com/LTplus-AG/ifc-lite/commit/80a0cd9b946a5ff1aa6ca214ddb427a5d1f5303c), [`a99ecd9`](https://github.com/LTplus-AG/ifc-lite/commit/a99ecd9998dada941dc66e8bcc85ce3864b44065), [`cfee9b2`](https://github.com/LTplus-AG/ifc-lite/commit/cfee9b28f5e6bec2040a29cbf7917be4696f407e), [`ff292b6`](https://github.com/LTplus-AG/ifc-lite/commit/ff292b685a7c663ef3e79928a754667bb919066a)]:
  - @ifc-lite/parser@5.0.0
  - @ifc-lite/bcf@3.0.0
  - @ifc-lite/encoding@2.2.0
  - @ifc-lite/wasm@6.2.0
  - @ifc-lite/query@2.1.0
  - @ifc-lite/geometry@4.2.0
  - @ifc-lite/spatial@1.14.16
  - @ifc-lite/ifcx@4.0.0

## 1.9.2

### Patch Changes

- [#3257](https://github.com/LTplus-AG/ifc-lite/pull/3257) [`dcf3838`](https://github.com/LTplus-AG/ifc-lite/commit/dcf383831c7f3ec671360a39f6357b51821f2648) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Clash detection no longer reports a void against the element it cuts.
  
  The non-clashable filter listed `IfcOpeningElement` and `IfcOpeningStandardCase` by hand — one branch of the subtraction family in its IFC4 spelling. `IfcVoidingFeature` (IFC4) and `IfcEarthworksCut` (IFC4.3) are `IfcFeatureElementSubtraction` subtypes too, are meshed like any other product, and were becoming clash candidates, so every such void collided with its host. Subtraction features are now derived from the bundled schema union instead of enumerated, so a class a later schema adds is covered without another edit.
  
  Addition features stay clashable: `IfcProjectionElement` and `IfcSurfaceFeature` are physical material, so a clash against them is a real coordination problem.
- Updated dependencies [[`b456e27`](https://github.com/LTplus-AG/ifc-lite/commit/b456e279831dbde5b2889b788aada9bd06ff32b8), [`8092522`](https://github.com/LTplus-AG/ifc-lite/commit/80925228ec72aca31d7e9fa3ab4466895c4b1f66), [`98828c4`](https://github.com/LTplus-AG/ifc-lite/commit/98828c4b004506b6d31546ce93b533fa26e808ea), [`98828c4`](https://github.com/LTplus-AG/ifc-lite/commit/98828c4b004506b6d31546ce93b533fa26e808ea), [`c658213`](https://github.com/LTplus-AG/ifc-lite/commit/c658213bfa5c17a767c8534e68f2416bac780979), [`da266c1`](https://github.com/LTplus-AG/ifc-lite/commit/da266c1138767208f193083eb8b39d48e34b9a5d), [`c1490aa`](https://github.com/LTplus-AG/ifc-lite/commit/c1490aa48037c396d014f1dcb9647934fc16e43d), [`38460bd`](https://github.com/LTplus-AG/ifc-lite/commit/38460bd543d6c869db15f867b129db6f965695da), [`e2c67f0`](https://github.com/LTplus-AG/ifc-lite/commit/e2c67f084bfca20ff82460ae54aa80a383fcb39a), [`302121a`](https://github.com/LTplus-AG/ifc-lite/commit/302121ac7bc9312b1073738b3bbe0956ce452cf4), [`08cbf72`](https://github.com/LTplus-AG/ifc-lite/commit/08cbf72dbb3e375d20f703c8c813d4cd873657c1), [`5e236e2`](https://github.com/LTplus-AG/ifc-lite/commit/5e236e26a33bfc5e41d82ccd742351e743131293), [`8dd8a9d`](https://github.com/LTplus-AG/ifc-lite/commit/8dd8a9db10a2b2388a4e92f92f0835468ee58a69), [`c8049a0`](https://github.com/LTplus-AG/ifc-lite/commit/c8049a0bf464cd1fec7a4cd2aad2f08326e04737), [`50895fb`](https://github.com/LTplus-AG/ifc-lite/commit/50895fb5b3d57c95e00daccc1e560f5b619c535d), [`24c7abc`](https://github.com/LTplus-AG/ifc-lite/commit/24c7abc6510f2e469992c0e76554471bf1cfe296), [`d470d76`](https://github.com/LTplus-AG/ifc-lite/commit/d470d768cea3eb18dbb9c1138e128bc23ebfca68), [`ffe80a7`](https://github.com/LTplus-AG/ifc-lite/commit/ffe80a76ab269b6ce8abe52a9ebc7bd16c184db5), [`bb3fc2c`](https://github.com/LTplus-AG/ifc-lite/commit/bb3fc2c5af754a120b98b545e186303de0fb4951)]:
  - @ifc-lite/parser@4.3.2
  - @ifc-lite/ifcx@3.0.1
  - @ifc-lite/wasm@6.1.0
  - @ifc-lite/geometry@4.1.0

## 1.9.1

### Patch Changes

- [#3041](https://github.com/LTplus-AG/ifc-lite/pull/3041) [`5ea5f99`](https://github.com/LTplus-AG/ifc-lite/commit/5ea5f9969f3a4a3f8b21eb2a90a1df2be48eb7b0) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Drop the no-op dedup `Set` from `queryMeshCross`, removing a quadratic allocation and an uncapped `Set` from contact clustering's inner loop.
  
  `queryMeshCross` funnelled its candidate triangle pairs through a `Set` keyed `` `${iA}|${iB}` ``, described in its own comment as "belt-and-braces" because BVH leaves partition the triangle set. That reasoning holds, and the set removed nothing: `buildNode` splits a node's indices into disjoint, covering halves and a leaf keeps exactly its own slice, so every triangle lives in exactly one leaf; and `crossNode` reaches any node pair by a single route, descending both sides together while both are internal and only the internal side once the other is a leaf. Each leaf pair is therefore visited once and each `(iA, iB)` emitted at most once.
  
  What it did cost was one key string and one `Set` entry per emitted pair — O(triangles_A × triangles_B) in the worst case, for a single element pair, with no cap. `Set` shares V8's hard 2^24-entry ceiling, and 4096 × 4096 = 2^24, so two roughly 4k-triangle elements whose AABB filter passes nearly everything sit exactly on it.
  
  Output is unchanged, in content and in order. New tests pin the emitted pair list against a brute-force ground truth across leaf sizes, triangle counts, epsilons and lopsided trees, and check the leaf partition directly; deliberately breaking either the partition or the traversal's single-visit property makes them fail.
- Updated dependencies [[`93b450c`](https://github.com/LTplus-AG/ifc-lite/commit/93b450c1cc0c3cee811625989edb82cf522c70c4), [`ddf9f1d`](https://github.com/LTplus-AG/ifc-lite/commit/ddf9f1da830cef5f941ea09e8aee19624e9def3a), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`e19aa0e`](https://github.com/LTplus-AG/ifc-lite/commit/e19aa0ef271eccc7f2f6862b8580e9f98dbd1a66), [`0ea7167`](https://github.com/LTplus-AG/ifc-lite/commit/0ea7167a6bd96d5b5e12e7e5a8c5615ab0b7c3b2), [`e6caf11`](https://github.com/LTplus-AG/ifc-lite/commit/e6caf11a8f8d9d8634a6811b6705ab3367cd02e0), [`7ff31ba`](https://github.com/LTplus-AG/ifc-lite/commit/7ff31ba854671a9ca3ebbf30b15e928e1b52a8b9), [`8ba612f`](https://github.com/LTplus-AG/ifc-lite/commit/8ba612f90d3bb0ad41f756d6fdef6b3250e8d330), [`8571d70`](https://github.com/LTplus-AG/ifc-lite/commit/8571d70270d072170fc4e204e8b0d11a424d2330), [`5781e5c`](https://github.com/LTplus-AG/ifc-lite/commit/5781e5c2998111926683419d27f8efa3519de7c6), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`063a140`](https://github.com/LTplus-AG/ifc-lite/commit/063a1408e4c54ebc874618f8d68fe298ed3f3a6f), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`f76c805`](https://github.com/LTplus-AG/ifc-lite/commit/f76c80511dce5ffc1756365b786042c4bc64808d), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`4a8fe77`](https://github.com/LTplus-AG/ifc-lite/commit/4a8fe77707127d251702610490f53430610e4ef7), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`f449776`](https://github.com/LTplus-AG/ifc-lite/commit/f4497765cb4e17828ff6ca6b52fb8a96caa2f81f), [`dec0708`](https://github.com/LTplus-AG/ifc-lite/commit/dec0708ef841c88abea6ec91404419fd7a3d93c6), [`dec0708`](https://github.com/LTplus-AG/ifc-lite/commit/dec0708ef841c88abea6ec91404419fd7a3d93c6), [`dec0708`](https://github.com/LTplus-AG/ifc-lite/commit/dec0708ef841c88abea6ec91404419fd7a3d93c6), [`932f043`](https://github.com/LTplus-AG/ifc-lite/commit/932f0439fc1625419aae3cf2d9f81a614fb2273c), [`754837b`](https://github.com/LTplus-AG/ifc-lite/commit/754837b066172dad8afcdf1a0104f1a021b5f6e5), [`2273a73`](https://github.com/LTplus-AG/ifc-lite/commit/2273a73127d03ec36d667544da6237479737881a), [`131e3dc`](https://github.com/LTplus-AG/ifc-lite/commit/131e3dc84244d9dd24859a5923ef0aef4d6119c4), [`fdd6121`](https://github.com/LTplus-AG/ifc-lite/commit/fdd61211e41d3e563a7604ac5e0630a9daae2de1), [`78d85dc`](https://github.com/LTplus-AG/ifc-lite/commit/78d85dcd4c59ee5b3b3b7857a454113c4911bc36), [`147693a`](https://github.com/LTplus-AG/ifc-lite/commit/147693a7a8fd0778ddb71839199b75bf1d622327), [`bea50bd`](https://github.com/LTplus-AG/ifc-lite/commit/bea50bd7bca7fdf69f01076ebb96a31b8e797a46), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`00f6e79`](https://github.com/LTplus-AG/ifc-lite/commit/00f6e79c22641ff59bfb3327d910b04f9a164d8b), [`e43582b`](https://github.com/LTplus-AG/ifc-lite/commit/e43582b069007c6c2c932f6981743a80630fe217), [`043e06a`](https://github.com/LTplus-AG/ifc-lite/commit/043e06a05c6625fef91bb17d84e3a3447f1379e3)]:
  - @ifc-lite/bcf@2.0.0
  - @ifc-lite/parser@4.3.0
  - @ifc-lite/wasm@6.0.0
  - @ifc-lite/ifcx@3.0.0
  - @ifc-lite/geometry@4.0.0
  - @ifc-lite/query@2.0.0
  - @ifc-lite/spatial@1.14.15

## 1.9.0

### Minor Changes

- [#2805](https://github.com/LTplus-AG/ifc-lite/pull/2805) [`0a10389`](https://github.com/LTplus-AG/ifc-lite/commit/0a1038972a72b27bda99c8793055efe39d623f10) Thanks [@louistrue](https://github.com/louistrue)! - Expose an exact minimum-distance query between two meshes, with witness points.
  
  `triTriDistance` already computed the exact triangle-to-triangle minimum
  distance, but it lived under `math/`, which has no export subpath, so any
  consumer outside the package hit `ERR_PACKAGE_PATH_NOT_EXPORTED`. What did not
  exist anywhere was a traversal that can find the CLOSEST pair: every BVH query
  in the package is an overlap predicate, so two disjoint meshes yield an empty
  candidate set and there is nothing left to measure.
  
  Adds `minDistanceBetweenMeshes` / `minDistanceBetweenBvhs` (branch-and-bound
  over the two BVHs, pruning on the exact AABB lower bound) and re-exports
  `buildMeshBvh` / `queryMeshCross` from `@ifc-lite/clash/contact` so a caller
  measuring one element against several can build each tree once. Additive: no
  existing export changes.

### Patch Changes

- [#2819](https://github.com/LTplus-AG/ifc-lite/pull/2819) [`432fdb8`](https://github.com/LTplus-AG/ifc-lite/commit/432fdb8dd12dd90af17d1ca3ce24a2fd5b7168b0) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix two divergences between `@ifc-lite/clash`'s STEP and IFCX source adapters, found by comparing them side by side.
  
  `adapters/ifcx.ts` had no equivalent of `adapters/step.ts`'s [#1464](https://github.com/LTplus-AG/ifc-lite/issues/1464) non-clashable-tag filter: an IFCX-sourced model reproduced the same phantom-clash bug class (openings, spaces, and spatial containers with tessellated geometry becoming ordinary clash candidates) that [#1464](https://github.com/LTplus-AG/ifc-lite/issues/1464) fixed for STEP.
  
  `adapters/step.ts` had no equivalent of `adapters/ifcx.ts`'s per-entity mesh coalescing: an entity with more than one mesh representation (e.g. Body + Axis) produced one `ClashElement` per mesh instead of one per entity, and `buildStepExclusions`'s `byExpressId` map silently kept only the last mesh's geometry for that entity.
  
  Both the non-clashable-tag filter and the mesh-coalescing logic now live in one shared module (`adapters/shared.ts`) that both adapters call, instead of two copies that could (and did) drift apart. `elementsFromIfcx`'s `tag` is already the real IFC class code, spelled identically to STEP's `node.type`, so the filter applies verbatim; merged bounds are derived from the merged geometry, so the union is correct without a separate "combine bounds" step.
  
  No existing fixture's clash count changed: the affected code paths (IFCX openings/spaces/containers, STEP multi-mesh entities) had no prior test coverage to regress.

- [#2704](https://github.com/LTplus-AG/ifc-lite/pull/2704) [`6a43522`](https://github.com/LTplus-AG/ifc-lite/commit/6a43522cdf3b0a9b0f7ce303b59f479dca2a2aca) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix clash element identity for federated models past the first.
  
  The viewer's loader shifts every `mesh.expressId` into the federated global id
  space in place, while `IfcDataStore` keeps local express ids. `elementsFromStep`
  used `mesh.expressId` to address the store anyway, so for any model with a
  non-zero `idOffset` every lookup missed: `key` fell back to the synthetic
  `expressid:N`, `tag` read `Unknown`, name and storey came back empty, and
  `buildStepExclusions` found no relationships — so the void / host / assembly
  exclusions silently stopped excluding, and a door in the opening it fills was
  reported as a hard clash. `ref` was wrong in the other direction, with
  `federation.toGlobalId` adding the offset a second time.
  
  `elementsFromStep` now takes `meshIdOffset`: the shift the host has already
  applied to `mesh.expressId`. It subtracts that back out before touching the
  store, so the store is addressed locally and the federation offset is applied
  exactly once. Callers that pass local meshes (CLI, MCP, the playground) leave it
  at its `0` default and are unaffected — it stays optional deliberately, since
  `elementsFromStep` is published API and requiring it would break every external
  caller. To keep a forgotten offset from being silent in any host, the adapter
  now also warns once when every element in a model resolves to an empty GlobalId
  *and the store does hold GlobalIds* — the signature of exactly this wiring
  mistake. A model whose store has none (a GLB import, whose store carries
  geometry and no IFC entities) is left alone: there, every element missing is the
  normal state, not a defect.
  
  The synthetic key an element without a GlobalId falls back to is now scoped to
  its model — `expressid:<encoded modelId>:<expressId>` rather than
  `expressid:<expressId>`. Express ids are only unique within a model, and review
  state and user element-pair exclusions are keyed on the element key alone
  (deliberately, so they survive a reload), so in a federation the unqualified
  form made two models' elements one identity: a review status or an exclusion set
  on one model's element silently covered another model's element. Two federated
  GLB models produced ONE review key where there should have been two.
  
  Migration: elements that have a GlobalId — nearly all of them, and every one
  this fix restores — are unaffected; only the fallback changes shape. A review
  status or an element-pair exclusion a previous session stored against the old
  `expressid:N` string stops matching: the clash comes back as `open`, the
  exclusion rule stays listed but suppresses nothing. Nothing is mis-applied, and
  nothing else reads the string. In the viewer that fallback is per-load anyway
  (the model id is a per-load uuid), which is the honest position for an element
  that carries no durable identity of its own. Review status a pre-fix session
  saved against a federated model past the first was likewise keyed on the old
  fallback and no longer matches.

- [#2878](https://github.com/LTplus-AG/ifc-lite/pull/2878) [`b699875`](https://github.com/LTplus-AG/ifc-lite/commit/b6998754039676def950735335147556afcb2977) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix clash detection silently skipping every GPU-instanced entity.
  
  `useClash` built its clash elements from `model.geometryResult.meshes` alone, which excludes every entity whose geometry was fully GPU-instanced — anything repeated 8 or more times (`INSTANCE_MIN_OCCURRENCES` in the wasm mesher). Doors, windows, columns, sprinklers, light fittings, and other repeated components vanished from clash detection with no error, no warning, and no count discrepancy: the report simply came back short.
  
  `gatherElements` now restores those entities with `withInstancedMeshes` — the same helper the glTF/IFC5 export path already uses ([#2558](https://github.com/LTplus-AG/ifc-lite/issues/2558)/[#2576](https://github.com/LTplus-AG/ifc-lite/issues/2576)) to reach instanced-only geometry through `Scene.getAllInstancedMeshData()`. This surfaces real triangles from the live renderer scene, not an AABB approximation, so a clash reported off an instanced entity is exactly as exact as one reported off a flat mesh.
  
  This also covers federated models. `withInstancedMeshes` used to gate on `isPrimary` and no-op for every non-primary model — correct when it was written, but GPU instancing stopped being primary-only once federated models got instanced shards too ([#2255](https://github.com/LTplus-AG/ifc-lite/issues/2255)), and the gate was never updated, so a federated model's own instanced entities were silently skipped for both clash and every glTF/IFC5/KMZ export call site. The helper now takes this model's `{ idOffset, maxExpressId }` id-range bracket instead of a boolean, scoping `getAllInstancedMeshData()`'s all-models output down to just this model's occurrences — restoring a federated model's own instanced entities without a federation of N models double-counting each other's.
  
  `elementsFromStep` (`@ifc-lite/clash`) now also keys an element's identity on `MeshData.occurrenceKey` when present, so distinct physical occurrences of one GPU-instanced expressId no longer collapse onto a single review/exclusion key, and a relationship-derived exclusion (void/host, assembly) fans out to every occurrence sharing that expressId instead of only the last one built.
  
  That per-occurrence `key` is one `ClashElement` per `MeshData`, so an entity with a mix of a flat submesh and an instanced occurrence (an ordinary shape once routing goes per-mesh, `rust/wasm-bindings/src/api/gpu_meshes/batch.rs:820-856`) now mints two elements with the SAME `ref` but DIFFERENT `key`s. The broad-phase self-clash guard only checked `key`, so that pair passed through as a false-positive self-clash — the entity clashing with itself. `candidatePairs`' guard (`@ifc-lite/clash`, `engine-ts/broad.ts`) now also treats a shared `ref` within the same model as the same entity.

- [#2815](https://github.com/LTplus-AG/ifc-lite/pull/2815) [`b3a4d30`](https://github.com/LTplus-AG/ifc-lite/commit/b3a4d307c50c9b0a8b8bb0e29952c4a98e417c16) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix `minDistanceBetweenMeshes`/`minDistanceBetweenBvhs` reporting a nonzero distance for a genuinely intersecting pair of triangles.
  
  `minDistanceBetweenBvhs` called `triTriDistance` unconditionally on every candidate leaf triangle pair, with no `triTriIntersect` gate. `triTriDistance`'s own contract says it is "only invoked for non-intersecting pairs" — intersecting triangles must be detected separately. For an axis-aligned box-overlap pair the missing gate happened not to matter (overlapping-box vertices/edges land exactly on the boundary features `triTriDistance` samples, so it returned 0 anyway), which is why the existing test suite did not catch it. A tilted, non-axis-aligned triangle pierced through another triangle's face interior has no such coincidence and returned a nonzero gap for two surfaces that actually overlap, contradicting `MeshDistance.distance`'s own documentation ("0 when they touch or overlap").
  
  The traversal now tests `triTriIntersect` before `triTriDistance` on each candidate leaf pair, the same order `engine-ts/narrow.ts` already uses for its per-pair test. Since 0 is the smallest distance this query can ever report, finding an intersecting pair now returns immediately rather than continuing to search the remaining frontier.

- [#2818](https://github.com/LTplus-AG/ifc-lite/pull/2818) [`5334bd1`](https://github.com/LTplus-AG/ifc-lite/commit/5334bd1589acb1c4b81a1f255d1a9171530b1467) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix two clash-detection bugs.
  
  `matchesSelector` mishandled a selector made of only negated alternatives
  (e.g. `!IfcWall|!IfcSlab`): the top-level `!` handling stripped only the
  first leading `!` and negated the recursive match on the remainder, so the
  second exclusion's type still matched. `matchesSelector('IfcSlab',
  '!IfcWall|!IfcSlab')` returned `true` instead of `false`. A pure negation
  list is now treated as an implicit AND of exclusions -- "match everything
  except A and except B" -- rather than the literal (and useless, tautological
  for any single input) OR-of-negations reading. Mixed positive/negative
  selectors (e.g. `IfcWall|!IfcSlab`) are unaffected.
  
  `clusterSharedFaces`'s `classify` step relabeled a small-area coplanar
  contact (area between `pointAreaM2` and `surfaceAreaM2`) as `kind: "line"`,
  but such a cluster comes from `buildSurfaceCluster`, which always sets
  `length_m: 0` -- contradicting the field's own documented invariant
  ("line only -- 0 otherwise") and the viewer's contact overlay, which renders
  `"line"` clusters as a 2-point segment rather than the polygon boundary a
  surface cluster actually has. This band is now classified `"surface"`.

- [#2839](https://github.com/LTplus-AG/ifc-lite/pull/2839) [`b1ac6be`](https://github.com/LTplus-AG/ifc-lite/commit/b1ac6be425cd89ff90eaab02636211f0d928b3e6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add direct tests for `runClash`'s shared orchestration (severity resolution, exclusions, dedup, sort ordering, summary tallies) and document a blind spot in `differential.test.ts` ([#2830](https://github.com/LTplus-AG/ifc-lite/issues/2830)).
  
  `engine-wasm/index.ts` calls the same `runClash` (`engine-ts/orchestrator.ts`) as `engine-ts/index.ts`, so the differential suite comparing the two backends can never catch a bug in that shared orchestration — only in the geometry kernel. Verified: constant-folding `inferClashSeverity` to always return `'info'` left all 16 differential tests passing.
  
  The suite's header now says so explicitly. `engine-ts/orchestrator.test.ts` (new) drives `runClash` directly through a fake kernel to cover severity resolution, exclusion gating, identity/dedup, and sort ordering on their own terms; `analysis.test.ts` gained direct coverage of `summarizeClashes`'s tallies. No behavior changes — tests only.

- [#2816](https://github.com/LTplus-AG/ifc-lite/pull/2816) [`c233d48`](https://github.com/LTplus-AG/ifc-lite/commit/c233d48a935a70851271b61a305f43dd9261dcca) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add frozen-output vectors that pin `uuidFromSeed`'s hard-coded expected UUIDs.
  
  Every existing test touching `uuidFromSeed` (in `bcf-bridge.test.ts`) either
  compared two calls against each other within the same process, or checked
  shape/regex/version-nibble — none asserted a fixed expected value. That is
  the same shape as an encode/decode pair sharing a table: internally
  consistent, free to drift. Confirmed by mutation: replacing all four salt
  constants in `deterministic-uuid.ts` with different arbitrary values still
  produced valid-shaped, self-consistent UUIDs, and the existing suite stayed
  green.
  
  These are BCF topic guids: `bcf-bridge.ts` derives a topic's guid from
  `uuidFromSeed(group.id)` so that re-running the same coordination produces
  byte-identical topic guids and previously exported BCF topics keep
  correlating with the clash they describe. A silent change to the salts, the
  mixing/rotation order, or the version/variant nibble derivation would
  silently detach every previously exported BCF topic from its clash.
  
  No behavior change — this is test-only. The new vectors are frozen output
  captured from the current implementation, not values derived from any
  specification (there is no external reference for this algorithm); the test
  file documents this explicitly so a failing assertion is never "fixed" by
  regenerating the expected value from the new code.

- [#2820](https://github.com/LTplus-AG/ifc-lite/pull/2820) [`b28a629`](https://github.com/LTplus-AG/ifc-lite/commit/b28a629d49f279ce01537cb06ae4c28f32beb2bb) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Pin eight untested comparison-operator boundaries in the clash geometry kernel with exact-boundary fixtures found by mutation testing (flipping the operator killed zero tests): `contact/aabb.ts`'s `intersects()`, `contains()`, and `longestAxis()`; `contact/bvh.ts`'s and `contact/mesh-bvh.ts`'s inflated-bounds overlap checks; and `engine-ts/obb.ts`'s zero-thickness reject, noise-band skip, and through-penetration far-side check. No production logic changed — this is coverage-only.

- [#2881](https://github.com/LTplus-AG/ifc-lite/pull/2881) [`1900a1a`](https://github.com/LTplus-AG/ifc-lite/commit/1900a1a9f8174ef874dddbd1541ccadd9a89415e) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Pin the `depthClashResult` f32-precision-floor comparison (`<=` at `engine-ts/depth.ts:195`) with a fixture whose box-box MTD lands exactly on the computed floor value, found by mutation testing (flipping the operator killed zero tests — the nearest existing fixtures sit a decade below and well above the boundary). No production logic changed — this is coverage-only, ported 1:1 from the equivalent Rust pin in `rust/clash/src/kernel_tests.rs`.
- Updated dependencies [[`b9faf82`](https://github.com/LTplus-AG/ifc-lite/commit/b9faf8296f86943914c30550af8131fee250d4c8), [`8f89331`](https://github.com/LTplus-AG/ifc-lite/commit/8f893311b170a983e160737bd9479c3caf961911), [`bc179f6`](https://github.com/LTplus-AG/ifc-lite/commit/bc179f6a1091c8c307a07b31d8c30fbba140e4a9), [`b9faf82`](https://github.com/LTplus-AG/ifc-lite/commit/b9faf8296f86943914c30550af8131fee250d4c8), [`48b204b`](https://github.com/LTplus-AG/ifc-lite/commit/48b204b868016aad29b694b53ac8ace5e76a0542), [`c688a12`](https://github.com/LTplus-AG/ifc-lite/commit/c688a1272ec72d575e8ecf78072e0a0084b517ca), [`79322b6`](https://github.com/LTplus-AG/ifc-lite/commit/79322b6e76049be0df3b07149c711414bd80863e), [`2156528`](https://github.com/LTplus-AG/ifc-lite/commit/2156528c926114233c79ba74925c0c8656f1ea65), [`7869a90`](https://github.com/LTplus-AG/ifc-lite/commit/7869a90f35384ceba40b7ce4f3e9fadbe6990fa8), [`989ee2c`](https://github.com/LTplus-AG/ifc-lite/commit/989ee2c4e396575529488c17b73e1a884e4e8b9d), [`1cda2d0`](https://github.com/LTplus-AG/ifc-lite/commit/1cda2d04dc66542892dd0181768c027b3d1b4e6f), [`0ed2582`](https://github.com/LTplus-AG/ifc-lite/commit/0ed2582b71973fa6d16307999ed2ea59f7a2db3f), [`5a9ecfb`](https://github.com/LTplus-AG/ifc-lite/commit/5a9ecfb6bcd3190eae4463bd8926cf38a2143496), [`a29b040`](https://github.com/LTplus-AG/ifc-lite/commit/a29b04069fec3c6b726f49fc58054e535c255034), [`cc19a8d`](https://github.com/LTplus-AG/ifc-lite/commit/cc19a8d4a79a5e8563a90ab663b28e1b93ef9c18), [`36e4eca`](https://github.com/LTplus-AG/ifc-lite/commit/36e4eca3b19a2fe02f1679acc9a2a43cd90aa163), [`a7b8a20`](https://github.com/LTplus-AG/ifc-lite/commit/a7b8a201eaecd411a4246421893e887bf55aafd3), [`ad50aa9`](https://github.com/LTplus-AG/ifc-lite/commit/ad50aa9751c31f6895944e26ce19fe8cbbf3018e), [`105eb31`](https://github.com/LTplus-AG/ifc-lite/commit/105eb31e7ccdd697f74db3bc9fac41396cdc6faa), [`5254699`](https://github.com/LTplus-AG/ifc-lite/commit/52546994268440a468de81ce6ac0b385e6ef73d7), [`6ce17fa`](https://github.com/LTplus-AG/ifc-lite/commit/6ce17fa903d38ab8ee3e6ebaf6da8453726d3ce2), [`b7d2a11`](https://github.com/LTplus-AG/ifc-lite/commit/b7d2a11345add8acdf0926ade5d4c1ca19ccecf7), [`ae5a5ca`](https://github.com/LTplus-AG/ifc-lite/commit/ae5a5caa3e20304085ba14c0708cd026c1d4bf16)]:
  - @ifc-lite/bcf@1.18.2
  - @ifc-lite/geometry@3.8.4
  - @ifc-lite/parser@4.2.0
  - @ifc-lite/query@1.14.17
  - @ifc-lite/wasm@5.0.0
  - @ifc-lite/ifcx@2.3.7
  - @ifc-lite/spatial@1.14.14

## 1.8.0

### Minor Changes

- [#2535](https://github.com/LTplus-AG/ifc-lite/pull/2535) [`e5acbb2`](https://github.com/LTplus-AG/ifc-lite/commit/e5acbb2589628d7e9f8a9d640c4b82d11f510929) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Export `qualifiedKey` (the model-qualified element identity behind `pairKey`) and add `summarizeClashes`, which tallies a clash list into a `ClashSummary`. Both were already implemented internally: `qualifiedKey` lets a consumer build federation-safe pair identities without re-deriving the encoding, and `summarizeClashes` replaces the two private `buildSummary` copies in the TypeScript orchestrator and the duplicate scan, so a consumer that filters a `ClashResult` can rebuild its buckets the same way the engine does.

  The viewer uses `summarizeClashes` for user-defined clash exclusions: a coordinator can now mark an overlap as by design in three ways: a whole IFC type pair, a ONE-SIDED type rule that excludes every clash involving one type regardless of what it meets, or one specific element pair, see how many clashes each rule is hiding, and remove or disable it. The rules persist in local storage and are applied to the last run without re-detecting. `qualifiedKey` is exported for external consumers but is not called from the viewer itself, which keys exclusion rules on the durable element key alone (see `apps/viewer/src/lib/clash/exclusions.ts`).

### Patch Changes

- [#2661](https://github.com/LTplus-AG/ifc-lite/pull/2661) [`90d5b35`](https://github.com/LTplus-AG/ifc-lite/commit/90d5b3563c7732c674dfd4890ab94d201b83db3d) Thanks [@louistrue](https://github.com/louistrue)! - Fix fabricated coplanar contacts far from the origin in the contact narrow phase. The scaled plane-distance tolerance took the max abs coordinate over all three axes of both world AABBs, so an axis orthogonal to the tested plane normal could inflate the tolerance past a genuine clearance (2 mm clearance read as coplanar at 10 km along an unrelated axis). Per-axis f32-ULP noise amplitudes are now projected onto each tested plane's own normal, preserving the 1e-6 floor.

- [#2536](https://github.com/LTplus-AG/ifc-lite/pull/2536) [`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop reporting a wall's full height as the penetration depth where two walls cross.

  Two walls meeting at an X-junction — 200 mm thick, 3 m tall, one running along X and one along Y — reported `penetration 3.000 m` as a certified measurement. The shared volume is a 0.2 x 0.2 x 3 m column, so 0.2 m is the honest depth, and that is what the release before this one reported.

  The box-to-box minimum translation distance for that pair really is 3.0: the cheapest way to slide the two walls apart is straight up, along their shared height. That is the reason the exact box depth is withheld from any pair where one member pierces the other clean through — the number is then dominated by the piercing member's own extent, not by the material it actually crossed. The guard that detects the shape required the piercing cross-section to sit _strictly_ inside the other's, with a real margin. At an X-junction each wall does pierce the other clean through in thickness, but the two walls are the same height, so that axis ties exactly and the margin rejected the pair. The depth was then certified as measured and reached the user with no "estimate" qualifier.

  The containment test now admits a cross-section that touches the other's edges, so the tie no longer disqualifies the pair. What still disqualifies a pair is the separate test that the piercing member pokes out past the other on _both_ ends, which is untouched: stacked layers sharing a footprint, and a footing embedded into a slab from above, both keep their measured depth.

  Walls of unequal heights were affected too (a 3 m wall crossing a 2.5 m one reported 2.5 m), and so were crossing members of any size whose overlap ties on one axis.

  Also lands a brute-force oracle for the BVH-accelerated point-in-solid test, on a 2048-triangle sphere and a concave L-prism: 20,000 pseudo-random points each plus every triangle vertex probed either side of the surface, compared against an exhaustive scan over every triangle. Both kernels agree with the scan on every probe.

- [#2536](https://github.com/LTplus-AG/ifc-lite/pull/2536) [`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Replace the mesh-depth "measurement" with a real one, box-exact, for hard clashes.

  PR [#2536](https://github.com/LTplus-AG/ifc-lite/issues/2536) was held on review with a measured refutation: `TriMesh.maxPenetrationInto` (the `'mesh'`-labelled depth introduced by `clash-mesh-penetration-depth.md` / `clash-distance-provenance.md` in this same release) measures the distance from the nearest crossing-triangle VERTEX to the other solid's surface — an O(edge length) sampling artifact. On two 2x2x2 boxes overlapping exactly 1.5 m, tessellated at 12/48/192 triangles per element, it reported **0.03 / 0.50 / 0.07**, all labelled `'mesh'` — a sampling artifact that converges to 0 under retessellation, the opposite of what a depth metric should do, while the AABB estimate (labelled `'estimate'`) was the correct 1.5 m the whole time. The labelling had it backwards.

  This is fixed by removing `maxPenetrationInto` and replacing it with `obbPenetrationDepth` (`packages/clash/src/engine-ts/obb.ts`, `rust/clash/src/obb.rs`): when BOTH elements of a hard-clash pair are, within floating tolerance, rectangular boxes (`detectObb` — 3 mutually orthogonal face-normal families, 2 offset planes each, triangulation-independent), the reported depth is the minimum translation distance along a separating axis — the classical two-OBB penetration depth (Gottschalk), computed over the 15 canonical candidate axes (each box's 3 face normals plus the 9 pairwise cross products). This is provably exact for boxes, deterministic, and — because it is derived from the box's face-plane geometry rather than its triangulation — provably unchanged by retessellation; an analytic-oracle test suite (`obb.test.ts`, `tests.rs`) reproduces the maintainer's 0.03/0.50/0.07 numbers against the OLD metric, then asserts the NEW metric reports the true 1.5 m at all three tessellations, plus a 45°-rotated-box case with an independently-derived expected value and a barely-overlapping (5 mm) control.

  **This narrows what the engine claims to measure.** When either element is not a box, there is no certified box-box depth, and the pair falls back to the AABB estimate — labelled `'estimate'`, honestly, not `'mesh'`. This is a real, known regression relative to the removed probe for a handful of non-box shapes (e.g. a concave L-shaped member contained in another element): the reported depth goes back to being a bounding-box dimension rather than the shape's true penetration, exactly as it was before [#1866](https://github.com/LTplus-AG/ifc-lite/issues/1866), and the test suite (`boundaries.test.ts`, `engine.test.ts`, `tests.rs`) now documents this residual explicitly rather than hiding it behind an artifact that only looked right. A non-box depth metric — the maintainer's other suggested option, an intersection-volume-derived depth — is future work; the divergence-theorem machinery already used for the shape-signature work in this package is a plausible starting point, but deriving a _distance_ (not a volume) from it for non-convex solids needs its own design and did not fit in this correction.

  On a real model (AC20-FZK-Haus, 282 total distances across hard/clearance/touch), 9 pairs (3.2%) are now certified `'mesh'` (all box-box); the remaining 273 (96.8%) are `'estimate'`, numerically identical to the pre-[#1866](https://github.com/LTplus-AG/ifc-lite/issues/1866) baseline. This is a far smaller, more conservative change surface than the held PR's 71/282 relabelling, and none of the certified 9 can exhibit the sampling-artifact failure mode — the code path that produced it no longer exists.

  Both kernels changed identically (`obb.ts` / `obb.rs`, bit-identical `OBB_EPS = 1e-6` and axis-projection arithmetic), and the differential suite asserts `distanceKind` parity on every fixture. `TriMesh.distanceToSurface` and `containsPoint` are kept — they are exact, independently tested primitives, just no longer on this hot path.

  **Follow-up (review): a thin member piercing clean through another box was still mislabelled `'mesh'`, at up to 5.5x the true depth.** The box-box minimum translation distance is the wrong quantity for a through-penetration (a duct through a wall, a beam through a slab): it is dominated by the piercing member's own extent along the shared axis, not by the material actually crossed. A 0.4x0.4x2 m duct centred through a 5.0x0.2x3.0 m wall reported **1.1 m** (the duct's own half-length plus the wall's half-thickness) where the true wall thickness is **0.2 m** — and, unlike the pre-[#2536](https://github.com/LTplus-AG/ifc-lite/issues/2536) estimate, it carried the `'mesh'` label a coordinator would trust. `isThroughPenetration` (`obb.ts` / `obb.rs`) now detects this shape — one box's cross-section strictly inside the other's footprint along a shared axis, extending past it on both ends — and declines to certify it, falling back to the AABB estimate exactly as before [#2536](https://github.com/LTplus-AG/ifc-lite/issues/2536) existed. Only attempted when the two boxes share a common frame (every axis of one parallel to an axis of the other); at a generic relative rotation the box-box MTD is unchanged. Also closed: `detectObb` could certify a non-watertight mesh (e.g. a slab exported without its top face) as a zero-thickness box, because a face family whose triangles are all coplanar passed the 2-plane test with no positive extent — a positive-extent guard now rejects it.

  **Follow-up (review): the cross-axis degeneracy guard is now scale-relative, not absolute.** `obbPenetrationDepth` rejected a near-degenerate cross-product candidate with an absolute `len > 1e-6` test and divided by any accepted `len` unconditionally. At large operand scale that absolute cutoff fails in both directions, verified against an exact-rational-arithmetic oracle over all 15 candidates: for two 2000 km near-parallel beams meeting edge-to-edge, the dropped common normal IS the minimum-translation axis, so the min over the remaining axes reported a certified 0.45 m depth for a 0.02 m edge contact (22x); and a disjoint pair of the same beams reported a 0.055 m penetration because the only separating axis of the 15 was the dropped one. Each candidate's verdict now carries a noise bound derived from the operands themselves (the summed half-extents of both boxes plus the center offset, times `8 * EPS / len` - the projection error the `1/len` normalisation can amplify); a verdict inside its own band is skipped, which in a separating-axis test is the conservative direction (skipping a candidate can only fail to find a separation, never invent one), and a verdict outside the band is kept whatever `len` is. Identical change in both kernels (`obb.ts` / `obb.rs`), pinned by mirrored beam fixtures that fail on the old guard with bit-identical wrong values in TS and Rust.

- [#2536](https://github.com/LTplus-AG/ifc-lite/pull/2536) [`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39) Thanks [@BIMvoice](https://github.com/BIMvoice)! - **Corrected in this same release — see `clash-depth-box-exact-metric.md`.** The `'mesh'` label this changeset introduced was, for most hard clashes, applied to `TriMesh.maxPenetrationInto`'s output — a nearest-crossing-vertex sampling artifact, not a real measurement (see the superseding changeset for the analytic-oracle evidence). The `distanceKind` field and its meaning (`'mesh'` = certified measured, `'estimate'` = read off the AABBs) are unchanged; what changed is which pairs are ALLOWED to claim `'mesh'` — now only pairs where both elements are confirmed rectangular boxes, where the depth is provably exact. The description below is kept for history.

  Say which clashes report a measured penetration depth and which report an AABB estimate.

  `Clash.distance` carries two different quantities under one name. For a hard clash it is either a depth measured on the triangle meshes — the distance from the deepest crossing-triangle vertex inside the other solid to that solid's surface — or, when the narrow phase had no such vertex to measure from, the smallest overlapping bounding-box dimension of the two elements. Nothing in the output distinguished them, so a reader had no way to tell a real measurement from a number that is a property of the boxes and can equal an element's own thickness.

  The estimate is not a rare corner. It is what gets reported whenever the two surfaces merely coincide (stacked layers sharing a footprint), when one solid is modelled wholly inside another, and when a member pierces clean through so every crossing vertex sticks out the far side. On a layered infrastructure model, roughly a third of hard clashes land there, and their depths come out as the round layer thicknesses.

  `Clash` now carries `distanceKind: 'mesh' | 'estimate'` recording which one it is. `clearance` and `touch` distances are exact triangle-to-triangle measurements and are labelled `'mesh'`. The field is optional on the type only so a clash rehydrated from a run recorded before it existed stays assignable — absent means "unknown", never "measured".

  The CLI's human-readable clash list prints an estimated penetration as `penetration ~0.250m (AABB estimate)` instead of a bare `penetration 0.250m`.

  **This change adds only the label, no arithmetic.** It does not itself alter any `distance` value — it binds an existing internal boolean (whether the narrow phase found a mesh depth or fell back to the AABB reading) to the new field. Separately, `clash-mesh-penetration-depth.md` in this same release generalises which pairs take the mesh-depth path (previously only AABB-contained pairs; now every intersecting pair), which does change reported depths for some clashes — see that changeset. The estimates this label identifies are still bounding-box readings, not penetration depths; measuring a true depth for the coincident-surface case needs a translational penetration depth (Minkowski) over non-convex solids, which is a separate piece of work.

  The Rust/WASM kernel records and reports the same label over the same code paths, and the differential suite now asserts the two kernels agree on it exactly.

- [#2573](https://github.com/LTplus-AG/ifc-lite/pull/2573) [`33eb685`](https://github.com/LTplus-AG/ifc-lite/commit/33eb685de6c1578727587d87af5c3cd4a30a4122) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop treating spatial containers as clash bodies in the STEP adapter.

  `NON_CLASHABLE_TAGS` dropped `IfcSpace` and `IfcSpatialZone` ([#1464](https://github.com/LTplus-AG/ifc-lite/issues/1464)) but nothing else from the spatial structure, so any container that carries tessellated geometry became a clash body and collided with the elements assigned to it. That is not a coordination problem — a storey's geometry is its extent, and by construction it encloses its contents.

  It bites hardest on IFC4.3 infrastructure models, where storeys and facility parts routinely carry real bodies. On one road/bridge certification model a default `ifc-lite clash` run reported 235 clashes, of which 89 (37.9%) were an `IfcBuildingStorey` against an element it contains.

  The check is now derived from the schema instead of enumerated: an element is dropped when `getInheritanceChainAcrossSchemas` puts `IfcSpatialElement` or `IfcSpatialStructureElement` in its chain. That walks the bundled IFC2X3 + IFC4 + IFC4X3 union, so `IfcSite`, `IfcBuilding`, `IfcBuildingStorey`, `IfcExternalSpatialElement` and the IFC4.3 facility leaves (`IfcFacility`, `IfcFacilityPart`, `IfcBridge`, `IfcRoad`, `IfcRailway`, `IfcMarineFacility`, …) are all covered without a second hand-maintained list, and `IfcSpatialStructureElement` is checked alongside `IfcSpatialElement` because IFC2X3 has no `IfcSpatialElement`. The two hand-listed space entries are removed as redundant.

  Elements _contained in_ a container are unaffected — they still clash with each other, and still carry the storey name as metadata. Measured on the road/bridge model: 235 → 146 clashes, 89 pairs removed and none added, every removed pair involving `IfcBuildingStorey`. Building-model controls: 274 → 274 and 469 → 469 with byte-identical pair sets; 282 → 279 on a third, the three removed pairs all being the site's own terrain body.

  No API surface change.

- [#2536](https://github.com/LTplus-AG/ifc-lite/pull/2536) [`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39) Thanks [@BIMvoice](https://github.com/BIMvoice)! - The f32 precision floor takes precedence over depth derivation: a pair below the noise floor is `touch` no matter which quantity would have been reported, and the estimate-vs-mesh selection only applies to pairs already above the floor.

  Two halves, both closing routes by which this release's depth-provenance work could promote a sub-floor pair to `hard`:

  1. **Every mesh-labelling branch routes through one floor gate.** `testPair` (`narrow.rs`'s `test_pair`) has three separate places that can build a `hard` result off a box-exact or AABB-estimate depth - the surface-crossing branch, the fully-enclosed-solid branch, and the coincide/shared-volume branch - and only the first checked the floor introduced by [#2594](https://github.com/LTplus-AG/ifc-lite/issues/2594). A pair that was fully enclosed (or coincident-footprint) AND below the floor for its coordinate magnitude still reported `hard`/`mesh` at the exact depth. Reproduced with two 40 mm-overlap box slabs translated 1,000,000 units from the origin (floor ~0.238 m there): both branches returned `hard`/`mesh`/-0.04 in both kernels. Fixed by extracting the floor decision into one function each branch must route its candidate depths through (`depthClashResult` in the new `engine-ts/depth.ts`, `depth_clash_result` in the new `rust/clash/src/depth.rs`), so a fourth mesh-labelling branch added later inherits the precedence by construction.

  2. **The floor is tested against every candidate depth the pair has, not against whichever one the selection would report.** Three candidates exist: the AABB estimate (always), the box MTD (when both elements are certified boxes), and - for a CONTAINED pair - the crossing-vertex penetration. The pair is `hard` only when the smallest available candidate clears the floor; only then does the selection pick which above-floor number is reported and how it is labelled, so a `hard` distance clears the floor by construction. Without this, replacing a contained non-box pair's mesh-level depth with the AABB estimate flipped eight flush, designed-contact pairs on buildingSMART's `Infra-Bridge.ifc` (spandrel wall x arch segment, arch segment x filler; crossing-vertex penetrations 4.2e-8 to 1.9e-6 m, two-plus orders below their ~1e-5 floors) from `touch` back to `hard` at a fabricated 4.084 m - the contained element's own AABB extent - moving the CLI-default count pinned by [#2594](https://github.com/LTplus-AG/ifc-lite/issues/2594) from 50 to 58. It is 50 again, for the pinned reason that the floor wins.

  The crossing-vertex probe this reintroduces (`crossingVertexPenetration` / `crossing_vertex_penetration`) is NOT the depth metric this same release removed coming back: it is never reported and cannot label anything `mesh`. It answers only the yes/no question the floor gate asks - is any mesh-level penetration measurably above f32 noise at all - for the one pair class (AABB-contained) whose estimate is fabricated. Its known failure mode, underestimating true depth under retessellation, can only keep a pair BELOW the floor, which is the conservative direction for a noise gate.

- [#2665](https://github.com/LTplus-AG/ifc-lite/pull/2665) [`3dd3dd4`](https://github.com/LTplus-AG/ifc-lite/commit/3dd3dd41c50f027b705b3a3b04c72f3aea66c0df) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Duplicate detection abstains on bounds it cannot compare, and the position
  tolerance is documented as the bound it actually is.

  **Non-finite bounds no longer report a pair.** The distance gate was written as
  two rejections (`if (!boxesTouch(...)) return; if (dist > tolerance) return;`).
  Every comparison against `NaN` is false, so an element whose `bounds` carry `NaN`
  fell through both rejections and was reported as coincident with elements 100 m
  and 500 m away — and, not being evicted from the sweep either, with every element
  visited after it. The gate is now `if (!(dist <= tolerance)) return;`: an
  acceptance, so a distance that cannot be compared abstains instead of asserting a
  match. The deprecated `iouThreshold` branch is left as it is and does **not**
  match: on two solid `NaN` boxes it also reports nothing, but only because
  `similarity` clamps them to 0, and against a degenerate (zero-volume) element it
  takes the `aabbApproxEqual` fallback — whose per-axis comparisons are all false
  against `NaN` — and asserts the pair even at the default 0.9. Both behaviours are
  now pinned by tests so the difference is on record.

  **And one non-finite element no longer loses duplicates elsewhere.** The broad
  phase sorted element indices by `bounds.min[axis]` with a subtracting comparator,
  which answers `NaN` for every comparison involving a non-finite minimum. That is
  not a total order, so V8's TimSort returned an arbitrary permutation of the whole
  array; the sweep then saw minima going backwards, evicted boxes that were still
  live, and unrelated true duplicates were silently dropped — measured, 12
  coincident pairs in a 25-element model became 11. The comparator now compares a
  key instead of subtracting, with non-finite minima ordered last. Nothing changes
  for a model whose bounds are all finite.

  **And non-finite coordinates no longer become bounds.** `fromPositions`
  (`math/aabb.ts`) excluded `NaN` only as a side effect of `<` and `>` both failing
  against it; `±Infinity` propagated straight through into the bounds, and two
  elements each carrying `-Infinity` on the same axis give a NaN `boxDistance` that
  `boxesTouch` passes — a NaN distance without a NaN vertex. Whether the geometry
  pipeline can emit an infinite vertex is not established, so treat that as a
  mechanism rather than an observed path; the guard closes it at the source either
  way. `fromPositions` now requires each coordinate to be finite _after_ the
  transform is applied, per coordinate — the same rule `NaN` already got, so the
  finite coordinates of a partly poisoned vertex still count. Coordinates a real
  file can produce are finite, so no viewer or CLI result changes for them.

  **`positionTolerance` is an upper bound, not a per-axis guarantee.** The 1.7.0
  entry said the effective tolerance was "10 mm for every shape on every axis and
  on the diagonal". `boxDistance` is isotropic, but the pass also requires the two
  boxes to touch — enforced both by `boxesTouch` and, independently, by the broad
  phase's eviction on the axis it sweeps — and two copies stop touching once the
  offset exceeds the element's own extent on the offset axis. So the effective
  tolerance is `min(positionTolerance, extent on that axis)`: measured, a
  `[4, 0.2, 3]` m wall matches within 10.00 mm on all three axes, while a
  `[1.2, 0.002, 2.4]` m plate matches within 10.00 / 2.00 / 10.00 mm. A duplicated
  2 mm cladding panel offset 5 mm along its own normal is therefore not reported.

  That is deliberate rather than newly broken — the previous IoU gate missed the
  same pair, and inflating the touch test to make the pass isotropic reopens
  exactly the case the touch test exists to close (a 5 mm fixing pairing with a
  neighbour it never intersects); it breaks the two tests that pin that. So the
  behaviour stands and the claim is corrected, in the 1.7.0 changelog entry, on
  `positionTolerance`, on `boxDistance` and on `boxesTouch`, with a test pinning
  the real per-axis property so prose and code cannot drift apart again.

  Also corrected: a comment on the broad phase claimed "a pair that does not touch
  is rejected by the gate anyway", which holds for the distance gate but not for
  the deprecated IoU gate, whose degenerate fallback does match disjoint boxes.
  Comment only — that behaviour predates the distance gate and is unchanged.

- [#2536](https://github.com/LTplus-AG/ifc-lite/pull/2536) [`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Add the `distanceKind` getter to `ClashRunResult` (`rust/wasm-bindings/src/api/clash.rs`) that `@ifc-lite/clash`'s wasm engine reads.

  Without this changeset `@ifc-lite/clash` would publish depending on `@ifc-lite/wasm: workspace:^`, which npm can satisfy with a pre-existing `@ifc-lite/wasm` build that lacks the getter — `wasm-kernel.ts` would then read `undefined` off the result and throw reading an out-of-range index, on the first clash. This bumps `@ifc-lite/wasm` alongside `@ifc-lite/clash` so the published dependency range only ever resolves to a build that has the field.

- Updated dependencies [[`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39), [`33eb685`](https://github.com/LTplus-AG/ifc-lite/commit/33eb685de6c1578727587d87af5c3cd4a30a4122), [`2421442`](https://github.com/LTplus-AG/ifc-lite/commit/2421442363c5adf39d9405bf7a0e16b72adc73d1), [`f5c96c5`](https://github.com/LTplus-AG/ifc-lite/commit/f5c96c581eebfcc627be96de0670c9540b61623f), [`20d27aa`](https://github.com/LTplus-AG/ifc-lite/commit/20d27aaae4ce1d00bccd8a5a8a4c8410cbe1ba39)]:
  - @ifc-lite/wasm@4.7.0

## 1.7.0

### Minor Changes

- [#2530](https://github.com/LTplus-AG/ifc-lite/pull/2530) [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Report duplicates as coincident sets, not pairs. `findDuplicates` is pairwise, so N coincident copies of one object produce N(N−1)/2 rows and each copy is named in N−1 of them — three triplicated columns read as nine findings with every object mentioned twice. No row was ever literally repeated, but the list overstated the problem and the same object kept reappearing.

  New `groupDuplicateSets(result)` partitions a duplicate result into the connected components of the pair graph: each reported clash is an edge between two model-qualified `(model, key, ref)` elements — `ref` is in the node identity so two elements that share a GlobalId within one model stay distinct nodes instead of collapsing into one — and each component becomes one `ClashGroup` titled e.g. "3 coincident IfcWall objects". Unlike `groupClashes({ by: 'cluster' })` it needs no epsilon and cannot fuse two unrelated duplicate sets that happen to stand within the 1.5 m cluster radius of each other. Sets that span models group correctly (the same object delivered in two files). A set's severity is its most severe member, so a set containing an exact-duplicate pair still surfaces as `major`.

  Connected components treat coincidence as transitive, which under `positionTolerance` — the corner-distance gate `findDuplicates` uses by default — it strictly is not: A≈B and B≈C puts A and C in one set even if A≉C. That is deliberate — a chain of near-coincident objects is a single coordination issue, and the strict alternative would put the same object back into several findings.

  Detection and thresholds are unchanged; `ClashResult` still carries the same pairwise clashes, so the other grouping modes and BCF export are unaffected. In the viewer, a duplicate scan now RENDERS these sets: the clash panel shows one section per coincident set ("3 coincident IfcColumn objects") with the member pair rows inside it, instead of bucketing the pairwise rows under the generic severity/rule/type-pair headers; the scan's telemetry counts sets rather than pairwise rows for the same reason. The duplicate scan's position tolerance is also now a setting (Clash settings → "Duplicate tolerance", default 10 mm) — it previously always ran at the library default, with no viewer control.

  The panel's "Group by" control is now disabled during a coincident-set view: it previously stayed clickable and its selection persisted, but the sections it draws are always the coincident sets during a duplicates-only run, so choosing "By severity" or "By type pair" changed nothing on screen.

- [#2530](https://github.com/LTplus-AG/ifc-lite/pull/2530) [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Decide duplicates by a distance in metres, not by AABB intersection-over-union.

  `findDuplicates` called two elements the same object when their bounding boxes
  overlapped at IoU ≥ 0.9. IoU is a ratio, so that setting carried no physical
  tolerance: for two equal boxes offset by `d` along an axis of extent `e` the IoU
  is `(e − d) / (e + d)`, and the 0.9 default therefore allowed `d ≤ e / 19`.
  Measured over four common shapes and all three axes, the displacement that still
  counted as a duplicate ranged from 5 mm (across a DN100 pipe) to 421 mm (in the
  plane of an 8 m slab) — an 80× spread from one number nobody set. A duplicated
  pipe nudged 5 mm was missed while a duplicated slab moved 400 mm was still
  reported.

  The gate is now `positionTolerance`, a distance in metres (default 10 mm),
  applied to the largest distance any corner of one box has to travel to reach the
  matching corner of the other. For two equally-sized boxes that is exactly the
  distance between their centres, whatever the shape and whatever the direction —
  the metric itself is isotropic, where IoU was not. A difference in size counts
  too — concentric boxes whose faces differ by δ are δ apart — so position and
  shape are checked by one number with no second, dimensionless knob.

  One precondition bounds that, and the broad phase enforces it a second time:
  boxes that do not touch at all are never paired,
  so an element smaller than the tolerance cannot be matched to a neighbour it
  does not intersect. Two copies stop touching once the offset exceeds the
  element's own extent on the offset axis, so the **effective** tolerance is
  `min(positionTolerance, extent on that axis)` — the full 10 mm on every axis of
  anything thicker than 10 mm, but only 2 mm along the normal of a 2 mm cladding
  panel (measured: a `[4, 0.2, 3]` m wall gets 10.00 mm on all three axes; a
  `[1.2, 0.002, 2.4]` m plate gets 10.00 / 2.00 / 10.00 mm). Offsets in the plane
  of that same panel still get the full 10 mm. A duplicated thin sheet nudged
  along its own normal by more than its thickness is deliberately read as two
  objects rather than one modelled twice — the same judgement that keeps a 5 mm
  fixing from pairing with a neighbour it never intersects. The previous IoU gate
  did not report that pair either, so this is a limitation the change did not
  remove, not one it introduced.

  `ClashResult.settings.tolerance` now reports the value that actually decided the
  matches. It previously advertised `positionTolerance`, which governed only the
  degenerate/planar fallback — the number on screen was not the number doing the
  work.

  What did not change: this is still a bounding-box test. Two elements with the
  same bounds and different solids inside them — a duct inside a shaft, an assembly
  and its own envelope — remain indistinguishable, and separating those needs a
  narrow phase this pass deliberately does not run.

  Compatibility. `positionTolerance` keeps its name and its default and is now the
  primary control; callers that raised it to loosen the planar fallback will find
  it loosens the whole pass. `exactTolerance` (default 1 mm) replaces
  `exactThreshold` for the `major`/`minor` split. `iouThreshold` and
  `exactThreshold` are deprecated but still honoured: passing either restores the
  previous IoU **matching gate** for that call — which pairs are reported,
  including the old degenerate/planar fallback, and the old `settings.tolerance`
  reading — rather than silently reinterpreting a ratio as a distance. It does
  not restore the rest of the old behaviour: severity and self-pair identity
  follow the new rules in every mode (see the shape-signature changeset).

  One matching change falls out of requiring the boxes to touch: two
  zero-thickness sheets offset a few millimetres **along their own normal** are
  disjoint and are no longer reported (the old planar fallback reported them).
  Geometry with clear air between the surfaces is two objects; the legacy IoU
  mode keeps the old reading.

  Across five public models the set of reported pairs is unchanged (1 / 0 / 0 / 0 /
  32). In the one model with a substantial count, eight same-triangle-count pairs
  that sit 1.7–4.5 mm apart move from `major` to `minor`: they are near-coincident,
  not exact copies, and the remaining 22 exact ones are all within 0.9 mm.

- [#2530](https://github.com/LTplus-AG/ifc-lite/pull/2530) [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Decide "exact duplicate" from the geometry, and stop hiding duplicated GlobalIds.

  **Triangle count was a two-way-wrong signature.** `findDuplicates` promoted a
  near-coincident pair to `major` ("exact duplicate") only when the two elements
  had the same number of triangles. That is a proxy for "same mesh", and it fails
  in both directions: a genuine duplicate re-tessellated on re-import (12 vs 48
  triangles, geometrically the identical box) was demoted to `minor`, while a
  round column and a square column that happen to share a bounding box and a
  triangle count were promoted to `major`. Users filtering to `major` therefore
  lost real duplicates and gained fake ones.

  Severity is now decided by a tessellation-invariant signature of the element's
  world-space triangle soup: total surface area and enclosed (divergence-theorem)
  volume. Both are integrals over the surface, so re-triangulating one copy leaves
  them unchanged — a 12- and a 48-triangle 1×1×3 box both give area 14 and volume
  3 — while a round and a square column of the same bounds differ by 22.7% in area
  and 25.0% in volume. The two must agree to within 5%, which is wide enough to
  hold together a 12- and a 36-segment column (4.0% apart in volume, the same
  authored solid at two facet densities) and ~5× tighter than the gap between
  genuinely different shapes. The tolerance is relative, so it means the same
  thing on a 50 mm fixing and a 30 m tank.

  The signature is per **element**, summed over the several meshes a
  multi-material / CSG element emits. Those parts' cross pairs all collapse to
  one clash id, so a per-mesh comparison would have let whichever part pairing
  the sweep reached first decide the label — a two-material wall and its exact
  copy could read `minor` because part 1 was first compared against part 2. The
  deduped finding is also upgraded to `major` when any later part pairing shows
  the copies coincide, so the label no longer depends on sweep order at all.

  `major` now means: some pair of the elements' boxes coincides within
  `exactTolerance` **and** the two elements' meshes agree on area and volume. It still cannot distinguish two different
  solids that happen to agree on both numbers, nor an element from its mirror
  image, and an element whose geometry the caller did not supply is never promoted
  at all. Matching — which pairs are reported — is unchanged and still
  bounding-box-only, so a duct inside a shaft that shares its bounds is still
  reported (as `minor`); separating nested from coincident needs a narrow phase
  this pass deliberately does not run.

  **Duplicated GlobalIds were invisible.** The self-pair guard skipped any pair
  sharing a key and a model. But a file can carry one GlobalId on two genuinely
  different entities — a defect `ifc-lite validate` reports — and that is exactly
  the "same element exported twice" case a duplicate hunt exists to find. Identity
  is now `(model, ref)`: `key` is the GlobalId, which a broken exporter can
  repeat, while `ref` is the express id, unique by construction. The several
  meshes one element emits (one per material or CSG part) share both key and ref,
  so they are still skipped. `groupDuplicateSets` counts nodes the same way, so
  such a pair now reads "2 coincident objects" rather than "1".

  Clash ids are unchanged for well-formed files: the express id is folded into an
  id only for a key that two different elements actually carry, which is also what
  stops three copies under one GlobalId collapsing into a single deduped finding.

  Cost is unchanged. The signature is O(triangles), computed at most once per
  element and only for pairs that already coincide, so a model with no duplicates
  never reads a vertex. Across five public models the reported pairs, their ids,
  their severities and their groupings are all identical to the distance-tolerance
  baseline this builds on (1 / 0 / 0 / 0 / 32, split 22 `major` / 10 `minor` —
  "before" here means after that change, which itself moved eight pairs from
  `major` to `minor`; see its changeset); computing every element's signature eagerly,
  which the pass does not do, would cost 2.6 ms over the 236,795 triangles of the
  largest of them against a 215 ms pass (the measurement the `findDuplicates`
  docs cite).

- [#2599](https://github.com/LTplus-AG/ifc-lite/pull/2599) [`8324512`](https://github.com/LTplus-AG/ifc-lite/commit/8324512daee39a018056aa88a148f72791db89c4) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Distinguish "the clash matrix found nothing" from "the clash matrix had nothing to check".

  The built-in discipline matrix (`--matrix`) is shaped for MEP/HVAC/electrical/fire coordination: every preset's `selectorA` is one of those disciplines. Run it on a model with none of those element types — an infrastructure model, for instance — and every rule matches zero elements on the A side, so the matrix silently reports "0 clashes". That reads as "this model is clean" when it actually means no rule ever ran a real comparison.

  `ClashResult` now carries a `ruleCoverage` field (per-rule counts of matched elements on each side), and `@ifc-lite/clash` exports `classifyRuleCoverage`/`ruleHadNoMatch` to turn that into one of `clean` / `partial` / `no-match` / `unknown`. The CLI's `--matrix` (and any other rule set) prints a loud `WARNING` when no rule matched anything, and a shorter note when some rules did not, in both the human summary and the `--json` output (`ruleCoverageOutcome` + `ruleCoverage`); the viewer's clash panel shows the same warning in place of the "No clashes found 🎉" empty state. Zero clashes is never treated as an error — the CLI still exits 0 — this only makes the _kind_ of zero visible.

  The `no-match` warning's wording now depends on whether a real discipline matrix ran. `--matrix` runs many rules, so its "the matrix did NOT run" phrasing is accurate there. The default path (`ifc-lite clash <file> --a <selector> --b <selector>`, no `--matrix`) builds exactly one ad-hoc rule; when only one side's selector matches nothing (e.g. `--a IfcWall --b IfcRoof` on a model with no roofs), the _other_ side did match and no matrix was ever involved — the CLI now names the empty selector ("selector B (\"IfcRoof\") matched 0 elements") instead of claiming a matrix that never ran. The viewer's clash panel makes the same distinction for its own single-rule runs (`runAll`'s "Detect all clashes" and a one-off `runPreset`) versus a real multi-rule `runMatrix`.

  Out of scope: adding infrastructure-discipline presets to the built-in matrix. That's a product decision about what an infra clash matrix should contain, not something to bundle into a diagnostic fix.

- [#2645](https://github.com/LTplus-AG/ifc-lite/pull/2645) [`2d87b39`](https://github.com/LTplus-AG/ifc-lite/commit/2d87b3919c0ca5afff03e205c5f598142bbc980d) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Re-export `triangleArea` and the `Triangle` type from `@ifc-lite/clash`'s public surface (issue [#2199](https://github.com/LTplus-AG/ifc-lite/issues/2199): "mesh analysis reachable from TypeScript"). It previously existed only inside the package's clash contact solver, so nothing outside `@ifc-lite/clash` — including the viewer's Measure tool — could reach a triangulated-mesh area even though every `MeshData` already carries the `positions`/`indices` a caller needs.

  The Measure tool's Quantities panel ([#2199](https://github.com/LTplus-AG/ifc-lite/issues/2199) §1, element surface area) now reports a "mesh" area alongside the existing declared (net/gross/unqualified) and mesh volume rows: the selection's total triangulated surface area, summed live from mesh geometry via the newly-exported `triangleArea`. Unlike the mesh volume row, this needs no closed-solid proof, so it covers open shells and layered walls too — and unlike the mesh volume row, it is not invalidated by federation alignment re-baking, because it is recomputed from current vertex positions rather than read from a value cached before alignment ran. It is the sum of every meshed face (not one side), so it is labelled "mesh" and never presented as a `NetSideArea`/`GrossSideArea` equivalent. Where no mesh geometry exists for a selected element (e.g. an instanced-only occurrence with no flat mesh materialised), the panel says so rather than reporting zero.

### Patch Changes

- [#2600](https://github.com/LTplus-AG/ifc-lite/pull/2600) [`7f2d9cf`](https://github.com/LTplus-AG/ifc-lite/commit/7f2d9cf1fdcf8facd9bf3f1445ddf3c665206b76) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Scale the focused-clash contact-interface epsilon to coordinate magnitude, not a fixed 1e-6.

  `contactClusters` (used by the viewer's focused clash detail view, `apps/viewer/src/hooks/useClash.ts`, via `@ifc-lite/clash/contact`) computes the real contact geometry — shared-face polygon, intersection line, or point — between one clashing pair, via a Möller triangle-triangle test whose plane-distance tolerance (`planeEps`) defaulted to a fixed `1e-6` in `narrowPhase`.

  Geometry is ingested from f32 buffers throughout this codebase, so a fixed `1e-6` is only valid near the origin: the true discrete f32 ULP exceeds `1e-6` above 16 m and reaches ~4.9e-4 at 5 km. Two triangles authored to be exactly flush (a shared wall/slab boundary) round to _adjacent_, not bit-identical, f32 values once far from the origin, and the too-tight fixed epsilon then read that rounding noise as a genuine non-coplanar separation — dropping the shared-face contact entirely instead of reporting the surface. A synthetic pair of boxes flush at world x = 5000.5 m, with one side's boundary coordinate bumped by exactly one f32 ULP (the mechanism `fix(clash): float32-precision floor on penetration depth` measured directly on `Infra-Bridge.ifc`, 20 pairs bit-identical at the f32 ULP for their coordinate magnitude), lost its `surface` cluster entirely under the old fixed epsilon; the same case at 50 km showed the same loss.

  The fix, following that same narrow-phase fix's approach: `narrowPhase`'s default `planeEps` is now `max(1e-6, maxAbsCoord * 2^-22)` — the pair's own coordinate magnitude (from the two meshes' already-computed BVH root bounds, so no extra pass over the geometry) times the same `2⁻²²` f32-ULP term `near_band_from_extent` uses in `rust/geometry/src/kernel/mesh_bridge.rs` and `precisionFloor` uses in `engine-ts/narrow.ts`, floored at the old fixed `1e-6` so the scaled term can only widen the tolerance, never narrow it below what the fixed constant already provided. An explicit `planeEps` passed by a caller is unchanged and still wins.

  Near the origin, where the f32 ULP is far below `1e-6`, the new default is bit-for-bit identical to the old fixed constant on the existing near-origin fixtures in `contact.test.ts` (the overlapping-boxes and perpendicular-bars cases) — the focused-clash contact output for an ordinary building model near the origin is unaffected.

  No API surface change: `planeEps` remains an optional field on `NarrowPhaseOptions`/`ContactOptions`.

  A follow-up audit found a sibling defect one stage downstream in the same call path: `clusterSharedFaces` (`packages/clash/src/contact/shared-faces.ts`) hashes coplanar triangle pairs into shared-face clusters via `planeKey`, which quantises `plane.offset` — also a signed distance from the world origin — into buckets of fixed width `planeDistSnap`, default `1e-3`. Two triangle pairs that the now-fixed `planeEps` correctly recognises as coplanar can still round to f32 offsets that straddle a fixed `1e-3` bucket boundary once far from the origin, splitting one physical shared face into two `surface` clusters instead of merging it into one. Measured directly: a flat wall face triangulated as two independently-rounded patches, with the drift between them tuned to exactly one f32 ULP straddling a bucket boundary, reported 2 separate `surface` clusters at 5 km and 50 km from the origin under the old fixed `1e-3`; the same fixture reports 1 at both distances, matching the near-origin baseline, once `planeDistSnap` is instead scaled the same way as `planeEps` (`max(1e-3, maxAbsCoord * 2^-22)`, from a real extra pass over the pairs' own vertices — separate from the clustering loop, which only reads one vertex per triangle). This does not eliminate the underlying bug: `Math.round` still imposes a hard bucket boundary at whatever width `planeDistSnap` ends up, so a wider bucket only _reduces the probability_ that a given pair of offsets straddles it (roughly 48.8% down to 41.0% at 5 km, for a boundary drawn uniformly at random relative to the bucket) — it does not make straddling impossible, and a pair unlucky enough to straddle the (wider) bucket still splits into two clusters. `lineSnap` (the cross-line hash) was not touched: its base-point term has the same theoretical exposure, but no reproduction was attempted for it, so it is left as-is pending its own demonstration. Near the origin, the new default is bit-for-bit identical to the old fixed `1e-3` on the existing fixtures. `planeDistSnap` remains an optional field on `SharedFaceOptions`/`ContactOptions`; an explicit value passed by a caller still wins.

- [#2530](https://github.com/LTplus-AG/ifc-lite/pull/2530) [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - clash: drop IFC type objects from the clash and duplicate candidate set

  An `IfcWallType`/`IfcSpaceType`/`IfcDoorStyle` carries the `RepresentationMaps`
  template that its occurrences instantiate. The mesher turns that template into
  geometry, which lands on top of the very occurrences that use it — so the type
  read as a duplicate of its own occurrence, and clashed against elements it never
  physically touches. On one public sample model this accounted for 114 of 282
  reported clashes and for the model's only reported duplicate.

  Type objects are now filtered out alongside the other non-physical types, which
  also closes the gap the earlier `IfcSpace` exclusion left open: the space was
  excluded by name while `IfcSpaceType` sailed straight through.

  `isIfcTypeLikeEntity` is now exported from `@ifc-lite/parser` so the clash
  adapter uses the same predicate the parser classifies entities with.

- [#2574](https://github.com/LTplus-AG/ifc-lite/pull/2574) [`5cf117d`](https://github.com/LTplus-AG/ifc-lite/commit/5cf117d1eb16dba7f3e7be67114e26ce3ec44a8f) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop treating spatial containers as clash bodies in the STEP adapter.

  `NON_CLASHABLE_TAGS` dropped `IfcSpace` and `IfcSpatialZone` ([#1464](https://github.com/LTplus-AG/ifc-lite/issues/1464)) but nothing else from the spatial structure, so any container that carries tessellated geometry became a clash body and collided with the elements assigned to it. That is not a coordination problem — a storey's geometry is its extent, and by construction it encloses its contents.

  It bites hardest on IFC4.3 infrastructure models, where storeys and facility parts routinely carry real bodies. On one road/bridge certification model a default `ifc-lite clash` run reported 235 clashes, of which 89 (37.9%) were an `IfcBuildingStorey` against an element it contains.

  The check is now derived from the schema instead of enumerated: an element is dropped when `getInheritanceChainAcrossSchemas` puts `IfcSpatialElement` or `IfcSpatialStructureElement` in its chain. That walks the bundled IFC2X3 + IFC4 + IFC4X3 union, so `IfcSite`, `IfcBuilding`, `IfcBuildingStorey`, `IfcExternalSpatialElement` and the IFC4.3 facility leaves (`IfcFacility`, `IfcFacilityPart`, `IfcBridge`, `IfcRoad`, `IfcRailway`, `IfcMarineFacility`, …) are all covered without a second hand-maintained list, and `IfcSpatialStructureElement` is checked alongside `IfcSpatialElement` because IFC2X3 has no `IfcSpatialElement`. The two hand-listed space entries are removed as redundant.

  Elements _contained in_ a container are unaffected — they still clash with each other, and still carry the storey name as metadata. Measured on the road/bridge model: 235 → 146 clashes, 89 pairs removed and none added, every removed pair involving `IfcBuildingStorey`. Building-model controls: 274 → 274 and 469 → 469 with byte-identical pair sets; 282 → 279 on a third, the three removed pairs all being the site's own terrain body.

  No API surface change.

- Updated dependencies [[`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`5cf117d`](https://github.com/LTplus-AG/ifc-lite/commit/5cf117d1eb16dba7f3e7be67114e26ce3ec44a8f), [`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599), [`307693c`](https://github.com/LTplus-AG/ifc-lite/commit/307693c678d525ab007773f74e13a308bfe63b34), [`649aa0c`](https://github.com/LTplus-AG/ifc-lite/commit/649aa0ccbc4e67c233b9175a6a2f9c8e1ff310ec)]:
  - @ifc-lite/parser@4.1.0
  - @ifc-lite/wasm@4.6.0
  - @ifc-lite/geometry@3.8.3
  - @ifc-lite/ifcx@2.3.6

## 1.6.8

### Patch Changes

- [#2594](https://github.com/LTplus-AG/ifc-lite/pull/2594) [`9cccc00`](https://github.com/LTplus-AG/ifc-lite/commit/9cccc002f5f03ad96c710b6d2a1e12b1bf61172c) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop reporting float32-precision noise as hard clashes.

  The narrow phase classified any genuine (non-coplanar) triangle-mesh crossing as `hard`, regardless of how tiny the measured penetration depth was — including depths that are literally float32 rounding noise. Geometry is ingested from f32 buffers and stored/queried in f64 (`rust/clash/src/tri_mesh.rs`), so f64 arithmetic cannot recover precision the source data never had: two surfaces authored to be flush round to adjacent f32 values, and the tiny "penetration" between them is bit-noise, not a measurement.

  This defect is present broadly, not just on infrastructure models: on `ara3d/duplex.ifc` — an ordinary residential building, not previously wired into any clash regression test — CLI-default hard clashes drop from 274 to 184, a third of the total. Every one of the 90 removed pairs measures at or below 5.3 µm, and there is a clean, empty band between ~3 µm and ~20 µm with no clashes in it at all before the smallest surviving real clash appears. That empty band is the strongest evidence for the fix: the precision floor lands in a genuine valley in the data, three-plus orders of magnitude below any real construction tolerance, rather than cutting into a continuum of real small overlaps.

  On buildingSMART's `Infra-Bridge.ifc` sample, the same defect reported 31 spurious hard clashes at CLI defaults (of 81 total): 20 were bit-identical at `-2.384185791015625e-7` m — exactly the float32 ULP at coordinate magnitude `[2,4)` — across unrelated element-type pairs (`IfcColumn`×`IfcWall`, `IfcColumn`×`IfcMember`, `IfcColumn`×`IfcBuildingElementProxy`) at different physical locations on the model; the rest sat in the same `1e-8`–`2e-6` m noise band. These are joints designed to be flush (a pier meeting a spandrel wall, a deck resting on a girder), not coordination issues.

  The fix adds a penetration-depth floor scaled to the pair's own coordinate magnitude — `max(1.0, maxAbsCoord) * 2^-22`, the same `extent · 2⁻²²` term `near_band_from_extent` uses in `rust/geometry/src/kernel/mesh_bridge.rs` — rather than a fixed constant, since the float32 ULP at a coordinate near the origin is not the ULP at a coordinate far from it, and infrastructure models routinely sit far from the origin. A crossing at or below the floor is reclassified as `touch`, not `hard`: the surfaces genuinely are in contact, which is real information this codebase already tracks separately (the viewer's `clashHideTouching` toggle), so it is not silently dropped. CLI-default rules don't opt into `reportTouch`, so these pairs report zero clashes rather than a spurious hard one.

  Measured: `Infra-Bridge.ifc` 81 → 50 hard clashes at CLI defaults (TS and WASM/Rust backends agree); `ara3d/duplex.ifc` 274 → 184. The 8 real `IfcBeam`×`IfcBeam` coordination-issue pairs on Infra-Bridge are unaffected. The existing 193 synthetic clash-package tests (explicit mm/cm-scale overlaps, including the differential TS/WASM parity suite) show no count changes, since none of them exercise coordinates near the precision floor.

  Because the floor scales with coordinate magnitude, it grows with distance from the origin — see the `precisionFloor` / `precision_floor` doc comments in `narrow.ts` / `narrow.rs` for what that means on far-from-origin (e.g. georeferenced) models.

  No API surface change.

## 1.6.7

### Patch Changes

- [#2604](https://github.com/LTplus-AG/ifc-lite/pull/2604) [`3af6d2a`](https://github.com/LTplus-AG/ifc-lite/commit/3af6d2ad076e76fc95e58a9252bf712f8513c6e9) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Scale the "touching" band (`isTouching`, used by the viewer's `hideTouching` clash filter, touching-count badge, and per-row touching indicator) to a clash's own coordinate magnitude, not a fixed 1e-4 metres.

  Geometry is ingested from f32 buffers, so a fixed `TOUCHING_EPSILON` is only valid near the origin: the f32 ULP for a coordinate of magnitude `extent` is `extent * 2^-22`, and exceeds `1e-4` once `extent` passes ~1 km. Past that distance, a genuinely flush pair (a wall meeting a slab) can pick up more than `1e-4` of pure f32 rounding noise in its measured penetration depth, and the fixed band then misses it — the pair silently reappears as a hard clash in a list the user explicitly asked to de-noise. Demonstrated directly through `isTouching`: a flush pair 1 f32 ULP apart at each corner classifies as touching near the origin, but past the ULP-crossover distance (~1024 m for a single-ULP-scale overlap; real models with multiple rounding operations can cross earlier) the same pair's measured depth exceeds the fixed `1e-4` and it stops being flagged touching, under the old fixed constant, while an epsilon scaled to the identical coordinates keeps it flagged.

  The fix: `isTouching`'s default `eps` is now derived per-clash from `Clash.bounds` (the clash's own contact/overlap region — the only element-scale coordinates a bare `Clash` carries, since `ClashElement`'s bounds aren't available at this call site) as `max(TOUCHING_EPSILON, maxAbsCoord(bounds) * 2^-22)` — the same `2^-22` f32-ULP term used by `precisionFloor` in `engine-ts/narrow.ts` and `planeEps` in `contact/narrow-phase.ts`. Floored at `TOUCHING_EPSILON` itself (not the raw single-metre f32 floor those two use) so near the origin the new default is bit-for-bit identical to the old fixed constant — verified against the existing `analysis.test.ts` fixtures. An explicit `eps` argument is unchanged and still overrides the default entirely.

  `TOUCHING_EPSILON` remains exported with its existing value and meaning (the near-origin/floor band); `isTouching`'s signature is unchanged.

- Updated dependencies [[`cd72412`](https://github.com/LTplus-AG/ifc-lite/commit/cd724127245fcb767894642cd0994baaba88ff7d), [`b85b2be`](https://github.com/LTplus-AG/ifc-lite/commit/b85b2be4dd79045f1dd02ed344d102f27ecc2594), [`cd72412`](https://github.com/LTplus-AG/ifc-lite/commit/cd724127245fcb767894642cd0994baaba88ff7d)]:
  - @ifc-lite/geometry@3.8.2
  - @ifc-lite/parser@4.0.3
  - @ifc-lite/wasm@4.5.1

## 1.6.6

### Patch Changes

- [#2571](https://github.com/LTplus-AG/ifc-lite/pull/2571) [`495cc38`](https://github.com/LTplus-AG/ifc-lite/commit/495cc388ea95f6e55aee76ea37bcf6d11c99558b) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Report it when `groupClashes({ by: 'cluster' })` consolidates nothing, instead of silently returning one group per clash.

  Measured on a real MEP model (self-clash among drainage `IfcFlowSegment`s, distribution-run contact points scattered several metres apart): cluster grouping at the default 1.5 m epsilon produced 15 groups from 18 clashes — barely different from no grouping at all. The default epsilon was investigated separately and deliberately kept: across 12 public models there is no defensible constant (raising it to 2.0 m collapses an unrelated structural model's 10 real clashes into one group), so this is not a tuning fix.

  Adds `isClusterGroupingIneffective(clashes, groups)` to `@ifc-lite/clash`: a narrow, exact check — true only when every clash landed in its own singleton group (`groups.length === clashes.length`, with more than one clash) — deliberately not a fuzzy "mostly ineffective" threshold, which would repeat the epsilon problem with a different undefensible constant.

  `ifc-lite clash --bcf ... --group cluster` now prints a stderr note when this fires, naming the other grouping modes (`rule`, `typePair`, `element`) rather than picking one — none of them is a reliable universal answer either: on the measured model, `--group element` produced _more_ groups than clashes (33 from 18), since it files each clash under both participating elements rather than merging along the run.

- [`081ed7e`](https://github.com/LTplus-AG/ifc-lite/commit/081ed7e7e38072ecb307c01c0512cd911be886a6) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Stop treating spatial containers as clash bodies in the STEP adapter.

  `NON_CLASHABLE_TAGS` dropped `IfcSpace` and `IfcSpatialZone` ([#1464](https://github.com/LTplus-AG/ifc-lite/issues/1464)) but nothing else from the spatial structure, so any container that carries tessellated geometry became a clash body and collided with the elements assigned to it. That is not a coordination problem — a storey's geometry is its extent, and by construction it encloses its contents.

  It bites hardest on IFC4.3 infrastructure models, where storeys and facility parts routinely carry real bodies. On one road/bridge certification model a default `ifc-lite clash` run reported 235 clashes, of which 89 (37.9%) were an `IfcBuildingStorey` against an element it contains.

  The check is now derived from the schema instead of enumerated: an element is dropped when `getInheritanceChainAcrossSchemas` puts `IfcSpatialElement` or `IfcSpatialStructureElement` in its chain. That walks the bundled IFC2X3 + IFC4 + IFC4X3 union, so `IfcSite`, `IfcBuilding`, `IfcBuildingStorey`, `IfcExternalSpatialElement` and the IFC4.3 facility leaves (`IfcFacility`, `IfcFacilityPart`, `IfcBridge`, `IfcRoad`, `IfcRailway`, `IfcMarineFacility`, …) are all covered without a second hand-maintained list, and `IfcSpatialStructureElement` is checked alongside `IfcSpatialElement` because IFC2X3 has no `IfcSpatialElement`. The two hand-listed space entries are removed as redundant.

  Elements _contained in_ a container are unaffected — they still clash with each other, and still carry the storey name as metadata. Measured on the road/bridge model: 235 → 146 clashes, 89 pairs removed and none added, every removed pair involving `IfcBuildingStorey`. Building-model controls: 274 → 274 and 469 → 469 with byte-identical pair sets; 282 → 279 on a third, the three removed pairs all being the site's own terrain body.

  No API surface change.

## 1.6.5

### Patch Changes

- [#2424](https://github.com/LTplus-AG/ifc-lite/pull/2424) [`dae94e2`](https://github.com/LTplus-AG/ifc-lite/commit/dae94e23f7514945ca60f7074f50f196a90dfc5d) Thanks [@louistrue](https://github.com/louistrue)! - Cancel clash detection when the script run that asked for it ends.

  A sandbox run that exceeded `limits.timeoutMs`, or a sandbox disposed mid-run, stopped _waiting_ for `bim.clash.run` / `bim.clash.matrix` but never stopped the engine: it kept intersecting geometry to completion in the background, on the user's machine, for a result that was discarded on arrival. The bridge now hands every call an `AbortSignal` and aborts it on both paths, and the clash namespace forwards it as `ClashSettings.signal`.

  `@ifc-lite/sandbox` is a minor rather than a patch because `BridgeCallContext.hostSignal` is new capability surface for schema authors, reachable through the `@ifc-lite/sandbox/schema` subpath. Nothing was removed or renamed.

  `ClashSettings.signal` also now works the way its name implies. The TypeScript engine checked it periodically but only yielded to the event loop when an `onProgress` callback was supplied — and every realistic canceller (a deadline timer, a cancel button, a host teardown) fires _from_ the event loop, so without `onProgress` the flag could never flip mid-run. A caller that supplies a signal now gets the periodic yields too, the check runs every 256 candidate pairs rather than every 1024, and the signal is rechecked immediately after each yield, since the yield is the window the abort arrives in.

  One bound is worth stating plainly: those handlers can only run during a yield, and the first yield comes after ~50 ms of held thread time, so a run that finishes inside that window completes rather than cancelling. Cancellation is for runs long enough to be worth cancelling.

  No API changed shape: `ClashSettings.signal` already existed, and cancellation stays opt-in for direct engine callers.

- Updated dependencies [[`1843d9f`](https://github.com/LTplus-AG/ifc-lite/commit/1843d9f13a7a10183f780ae0a1df9dd225938e73), [`8b09cfd`](https://github.com/LTplus-AG/ifc-lite/commit/8b09cfdadafaea9806e79b73deb9119ea66b5aa4), [`d260a35`](https://github.com/LTplus-AG/ifc-lite/commit/d260a35669e379e5f465861294391c95ee48cb3d), [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`c866bee`](https://github.com/LTplus-AG/ifc-lite/commit/c866bee62a7d6e40b15a7de63948354cbbe049a7), [`262b9df`](https://github.com/LTplus-AG/ifc-lite/commit/262b9df485e4bfd3760f73c30d93bb518e599b72), [`2e16736`](https://github.com/LTplus-AG/ifc-lite/commit/2e167367037fa3b5d1d2d5d26dd4fb7ac169e2f5), [`d89960a`](https://github.com/LTplus-AG/ifc-lite/commit/d89960aaab08387fbd2307c0f238bd112c684933), [`51ec81b`](https://github.com/LTplus-AG/ifc-lite/commit/51ec81b125532cd0efe4f004c7ab01f4efe55cb8), [`958aef1`](https://github.com/LTplus-AG/ifc-lite/commit/958aef125743682da75c3da7b41991abd9d36d32), [`de7bd04`](https://github.com/LTplus-AG/ifc-lite/commit/de7bd04619a43a32900b188e0507b95e7542d8c8), [`09d67c7`](https://github.com/LTplus-AG/ifc-lite/commit/09d67c780bf68f58dec3f77920927857c752f8da)]:
  - @ifc-lite/bcf@1.17.0
  - @ifc-lite/query@1.14.16
  - @ifc-lite/ifcx@2.3.4
  - @ifc-lite/parser@4.0.0
  - @ifc-lite/geometry@3.7.1

## 1.6.4

### Patch Changes

- [#1877](https://github.com/LTplus-AG/ifc-lite/pull/1877) [`0cfb88b`](https://github.com/LTplus-AG/ifc-lite/commit/0cfb88b3ac3e5615c7e125c5076ea75cf2039a09) Thanks [@louistrue](https://github.com/louistrue)! - Report mesh-level penetration depth for contained contact pairs. When one element's AABB is contained in the other's, hard-clash findings previously reported the AABB signed gap (how deep the small box sits inside the big one) as the penetration depth, overstating depth for designed face contacts such as opening fills. Both the TS and WASM kernels now measure the depth at the crossing triangles' vertices (max point-to-surface inside the other solid), falling back to the AABB estimate only when no such vertex lies inside.

- Updated dependencies [[`0cfb88b`](https://github.com/LTplus-AG/ifc-lite/commit/0cfb88b3ac3e5615c7e125c5076ea75cf2039a09), [`35c157d`](https://github.com/LTplus-AG/ifc-lite/commit/35c157d9a0513f368e83c4884465b5ad162c6ba0), [`401ab18`](https://github.com/LTplus-AG/ifc-lite/commit/401ab1842662c4e8ca26eae01b879f0290962b6d), [`6842c56`](https://github.com/LTplus-AG/ifc-lite/commit/6842c56c72065fd9f43ac282cacb766b7808c282), [`6869d5c`](https://github.com/LTplus-AG/ifc-lite/commit/6869d5ced2d19ac4ab8b2591847f3ffd52236d14), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`b716fd7`](https://github.com/LTplus-AG/ifc-lite/commit/b716fd7b045c918dc1bd2ecc1da6fed21e59f110), [`428c5ae`](https://github.com/LTplus-AG/ifc-lite/commit/428c5ae54bac236a3950f451ee12a0dc23226336), [`3dc3eb5`](https://github.com/LTplus-AG/ifc-lite/commit/3dc3eb56bd372ddd0e317347db1cad888dffd609)]:
  - @ifc-lite/wasm@4.2.0
  - @ifc-lite/parser@3.11.0
  - @ifc-lite/ifcx@2.3.2
  - @ifc-lite/geometry@3.5.0
  - @ifc-lite/query@1.14.14

## 1.6.3

### Patch Changes

- Updated dependencies [[`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`8f3fafd`](https://github.com/LTplus-AG/ifc-lite/commit/8f3fafd7cc777e60cdc006956f8336680723c440), [`a2c31a1`](https://github.com/LTplus-AG/ifc-lite/commit/a2c31a185e868d15183df8360badb001789bd978), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`a1bbd6c`](https://github.com/LTplus-AG/ifc-lite/commit/a1bbd6c209ded2da1405a8d1c816a193601ae625)]:
  - @ifc-lite/ifcx@2.3.0
  - @ifc-lite/geometry@3.2.0
  - @ifc-lite/wasm@4.0.0
  - @ifc-lite/parser@3.8.5

## 1.6.2

### Patch Changes

- [#1691](https://github.com/LTplus-AG/ifc-lite/pull/1691) [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a) Thanks [@louistrue](https://github.com/louistrue)! - Documentation moved to https://ifclite.dev/docs/ - README links and package homepage fields now point at the new home (the GitHub Pages site remains as a mirror whose canonical URLs point there).

- [#1683](https://github.com/LTplus-AG/ifc-lite/pull/1683) [`3267aaf`](https://github.com/LTplus-AG/ifc-lite/commit/3267aaf5dfe98f9550695d44c1d12644f2c04b88) Thanks [@louistrue](https://github.com/louistrue)! - Internal replacement of the hand-written clash math (vec3, aabb, triangle-intersect) with Plato-generated single-source code. The generated kernel is post-processed by a deterministic codemod that rewrites scalar dispatch to native operators and lifts the former Number/Boolean prototype helpers into a module-scoped namespace, so there is no prototype pollution. A second codemod phase flattens the pure method bodies into tuple-native kernels (inlining + common-subexpression elimination), removing all per-call object allocation. The public API is identical, results are bit-identical, and the end-to-end TS clash engine benchmarks about 20 percent faster than the previous hand-written math.

- Updated dependencies [[`41794cd`](https://github.com/LTplus-AG/ifc-lite/commit/41794cde27d31904773bf2042eb0a0331aadf770), [`26af236`](https://github.com/LTplus-AG/ifc-lite/commit/26af236a9128f5fc97493d75d7c9642958343a7a), [`d0647c9`](https://github.com/LTplus-AG/ifc-lite/commit/d0647c9a1801fc03b7c5d32314e53ef922c56f2f), [`633882f`](https://github.com/LTplus-AG/ifc-lite/commit/633882fa15940f5faddb9dcb32031fcf3f38e287), [`40ac0a8`](https://github.com/LTplus-AG/ifc-lite/commit/40ac0a85d5aaac1b6fed9ad96b3e2f9d0378d65b), [`47bf759`](https://github.com/LTplus-AG/ifc-lite/commit/47bf759b1b801d44f6a0ba7408f65d368096cb04), [`26de705`](https://github.com/LTplus-AG/ifc-lite/commit/26de705b8608b9cd75e90411288c7ada96b3352b), [`bc1531f`](https://github.com/LTplus-AG/ifc-lite/commit/bc1531f899e5f8d18d1a6ff1ef6d997236a01243)]:
  - @ifc-lite/wasm@3.0.14
  - @ifc-lite/bcf@1.16.2
  - @ifc-lite/geometry@3.1.4
  - @ifc-lite/ifcx@2.2.2
  - @ifc-lite/parser@3.8.2
  - @ifc-lite/query@1.14.13
  - @ifc-lite/spatial@1.14.12

## 1.6.1

### Patch Changes

- [#1676](https://github.com/LTplus-AG/ifc-lite/pull/1676) [`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39) Thanks [@louistrue](https://github.com/louistrue)! - Docs refresh: correct stale README claims and API samples against the current codebase; add READMEs to the ten published packages that shipped without one (cli, create, sdk, sandbox, lens, lists, embed-sdk, embed-protocol, encoding, viewer-core).

- Updated dependencies [[`da04601`](https://github.com/LTplus-AG/ifc-lite/commit/da0460183dcb4e2b26ceb53cfebd8cca33c78c39), [`84cd5aa`](https://github.com/LTplus-AG/ifc-lite/commit/84cd5aa3b59bfb5cb5599423f22406f56f3c0e6c), [`2c52076`](https://github.com/LTplus-AG/ifc-lite/commit/2c5207631c3dbc164ffde0147a3cd71104006d36), [`a90182b`](https://github.com/LTplus-AG/ifc-lite/commit/a90182bac110fdd4c15b8b51866e31deefc0378e)]:
  - @ifc-lite/bcf@1.16.1
  - @ifc-lite/ifcx@2.2.1
  - @ifc-lite/parser@3.8.1
  - @ifc-lite/query@1.14.12
  - @ifc-lite/spatial@1.14.11
  - @ifc-lite/wasm@3.0.13

## 1.6.0

### Minor Changes

- [#1619](https://github.com/LTplus-AG/ifc-lite/pull/1619) [`6be7ad4`](https://github.com/LTplus-AG/ifc-lite/commit/6be7ad477e1f20d6ba1a90e5b5db4645fc48a960) Thanks [@louistrue](https://github.com/louistrue)! - Clash-to-BCF export (`createBCFFromClashResult`) now records a markup `<Header>` source file per distinct model each clash group spans, derived from the group members' `model` names. A cross-model clash topic therefore round-trips the provenance of both models it references (issue [#1591](https://github.com/LTplus-AG/ifc-lite/issues/1591)). Topics with no resolvable model name are unaffected.

### Patch Changes

- Updated dependencies [[`6be7ad4`](https://github.com/LTplus-AG/ifc-lite/commit/6be7ad477e1f20d6ba1a90e5b5db4645fc48a960), [`8c01c19`](https://github.com/LTplus-AG/ifc-lite/commit/8c01c19a09d9fa550329ad482b7a3ddf2b5c9d96), [`6b9418d`](https://github.com/LTplus-AG/ifc-lite/commit/6b9418d2bbd6765d33c60ecf04eb47362c8b856a)]:
  - @ifc-lite/bcf@1.16.0
  - @ifc-lite/wasm@3.0.9

## 1.5.0

### Minor Changes

- [#1577](https://github.com/LTplus-AG/ifc-lite/pull/1577) [`218e613`](https://github.com/LTplus-AG/ifc-lite/commit/218e613b06cc5ca2a74c84f72e039b430be6caee) Thanks [@louistrue](https://github.com/louistrue)! - Add a coordination REVIEW state for clashes, distinct from the detection classification ([#1468](https://github.com/LTplus-AG/ifc-lite/issues/1468)). A clash can now carry an `open` / `resolved` / `accepted` review status plus an optional comment, keyed by a new durable `clashReviewKey` that (unlike `Clash.id`) is independent of the ephemeral runtime `model` id, so a review re-attaches to the same clash across a reload, a re-run, or a model revision. `createBCFFromClashResult` gains an optional `reviewStatusOf` resolver: when given, each BCF topic's `TopicStatus` follows the least-resolved status among its members (`aggregateReviewStatus`), mapped to a BCF status via `reviewStatusToBcfTopicStatus` (max-interop: `open` -> `Open`, `resolved`/`accepted` -> `Closed`), and the finer review breakdown is recorded in the topic description so the resolved-vs-accepted split is not lost. Without the resolver, the previous flat `status` behaviour is unchanged. New exports: `clashReviewKey`, `aggregateReviewStatus`, `reviewStatusToBcfTopicStatus`, and the `ClashReviewStatus` / `ClashReview` types plus `CLASH_REVIEW_STATUSES` / `DEFAULT_CLASH_REVIEW_STATUS` constants.

### Patch Changes

- Updated dependencies [[`0762522`](https://github.com/LTplus-AG/ifc-lite/commit/076252241ec4201462f7fcf0555c83606de5fecd), [`d7a3205`](https://github.com/LTplus-AG/ifc-lite/commit/d7a3205524e023f936b29ee1bc113d1d10e3b0b1), [`52dd7a1`](https://github.com/LTplus-AG/ifc-lite/commit/52dd7a16788375a9507c40fbde106b78236801db), [`b157b48`](https://github.com/LTplus-AG/ifc-lite/commit/b157b4841bfa795f8a937a9be20c21b645757fbe)]:
  - @ifc-lite/geometry@3.1.0
  - @ifc-lite/parser@3.6.0
  - @ifc-lite/wasm@3.0.4

## 1.4.1

### Patch Changes

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`796f50a`](https://github.com/LTplus-AG/ifc-lite/commit/796f50a3b0072dd2c07b60ef84e3f1d2996444e2), [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`66f31ac`](https://github.com/LTplus-AG/ifc-lite/commit/66f31acb761209f7cf78e83ef01c02a1ec3dc13a), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`6a515ba`](https://github.com/LTplus-AG/ifc-lite/commit/6a515ba31bbe31bb6f018f7476cc9616e4691448), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/wasm@3.0.0
  - @ifc-lite/geometry@3.0.0
  - @ifc-lite/ifcx@2.1.6
  - @ifc-lite/query@1.14.11
  - @ifc-lite/parser@3.5.2
  - @ifc-lite/spatial@1.14.10

## 1.4.0

### Minor Changes

- [#1469](https://github.com/LTplus-AG/ifc-lite/pull/1469) [`731579f`](https://github.com/LTplus-AG/ifc-lite/commit/731579f6a981b5e55e36b8ff949dc5a51003ec08) Thanks [@louistrue](https://github.com/louistrue)! - Clash detection no longer treats non-physical / non-product geometry as a clash
  candidate ([#1464](https://github.com/LTplus-AG/ifc-lite/issues/1464)). Spatial volumes (`IfcSpace`, `IfcSpatialZone`), voids
  (`IfcOpeningElement`/`IfcOpeningStandardCase`), `IfcVirtualElement`, reference
  geometry (`IfcGrid`, `IfcGridAxis`, `IfcAnnotation`) and non-product material
  associations are dropped from the candidate set in `elementsFromStep`, so a
  "detect all" run and per-rule runs only ever consider real building elements
  instead of surfacing phantom clashes that no rule referenced.

## 1.3.0

### Minor Changes

- a7f257e: Show the focused clash's REAL contact interface instead of an AABB box (#1402). New `@ifc-lite/clash/contact`: `contactClusters(meshA, meshB)` returns the contact patches — the shared-face polygon for coplanar/flush overlaps (surface), the intersection line for crossings (line), or a point — classified by area/length, via a Moller triangle-triangle test plus shared-face clustering (coplanar pairs Sutherland-Hodgman clipped on their common plane and unioned into a boundary polygon; cross pairs unioned along the intersection line). Computed on demand for the single focused pair. The renderer gains `setClashContactLines()` to draw the contact polygon outlines / intersection lines; the viewer prefers this over the box.

### Patch Changes

- a7f257e: Fix clash false positives and overstated contact regions (#1362, #1402). The coplanar-overlap fallback now confirms a real shared volume (point-in-solid probe) before reporting a hard clash, so skewed or abutting members that only touch at a face are no longer flagged. Hard verdicts now report a tight contact AABB (clamped to the element overlap) instead of the full whole-element AABB overlap. The focused-clash region box draws this tight contact region (on by default, marking the penetration; toggle in clash settings), replacing the former whole-element box. The TS reference engine and the Rust/WASM kernel stay byte-compatible.
- Updated dependencies [1b148c1]
  - @ifc-lite/geometry@2.13.1

## 1.2.0

### Minor Changes

- [#1285](https://github.com/LTplus-AG/ifc-lite/pull/1285) [`593f02b`](https://github.com/LTplus-AG/ifc-lite/commit/593f02b471a894fd14d395edcfef575de7879738) Thanks [@louistrue](https://github.com/louistrue)! - Add duplicate / overlapping-element detection and result-analysis helpers.

  `findDuplicates(elements)` runs a cheap AABB + triangle-count pass (uniform hash
  grid, no narrow phase) to flag accidentally duplicated or coincident objects —
  the first thing reviewers look for in a single discipline model ([#1280](https://github.com/LTplus-AG/ifc-lite/issues/1280)). It
  returns a normal `ClashResult` (rule id `duplicates`) so the panel, grouping and
  BCF export render it with no special-casing.

  New pure helpers in `analysis.ts`: `penetrationDepth`, `isTouching` (identify
  zero-distance face/edge contacts, [#1273](https://github.com/LTplus-AG/ifc-lite/issues/1273)), `sortClashes` by severity / overlap
  depth / signed distance ([#1274](https://github.com/LTplus-AG/ifc-lite/issues/1274)), and `SEVERITY_RANK`.

### Patch Changes

- Updated dependencies [[`39400ee`](https://github.com/LTplus-AG/ifc-lite/commit/39400ee5bb48c1554656e1ac7aaf8a06ba2274cf), [`84c9f6e`](https://github.com/LTplus-AG/ifc-lite/commit/84c9f6e09eba2747b37da8f74aa7de23cb9f96d3), [`df607ef`](https://github.com/LTplus-AG/ifc-lite/commit/df607effd3a4cf2e0fb2898e14cb385df6d8e8d0)]:
  - @ifc-lite/parser@3.3.2
  - @ifc-lite/geometry@2.9.2
  - @ifc-lite/wasm@2.11.1

## 1.1.4

### Patch Changes

- [#1114](https://github.com/LTplus-AG/ifc-lite/pull/1114) [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb) Thanks [@louistrue](https://github.com/louistrue)! - Per-element local frame: eliminate f32 "fan" corruption on building-scale and georeferenced models.

  When a mesh is stored at f32 precision while its vertices sit at building-scale world coordinates (a model whose extent reaches ~200 m from the coordinate origin), the f32 mantissa only resolves ~15 µm there, so vertices closer than one ULP collapse to the same value and the triangles joining them fan out as long needles across the model. Lowering the global RTC threshold is the wrong lever (it is reserved for >10 km federation re-basing), and a single global recentre still leaves the model genuinely spanning ~200 m.

  Each element's vertices are now stored RELATIVE to a per-element `MeshData.origin` (the f64 AABB centre, snapped to the kernel reconcile grid `1/65536 m`), so the f32 coordinates stay element-small and collapse-free at any building or georef scale; the world position is `origin + position`. The renderer reconstructs world space with a per-batch model-matrix translate around a single shared scene origin (so abutting elements in different colour batches stay bit-coincident with no seam z-fighting), and the selection-highlight / GPU-picker buffers replicate the batch's exact f32 path so highlights are bit-coincident with no depth bias. The local frame is ON for the wasm (viewer) path and opt-in for native/server, so determinism snapshots and server output stay absolute-coordinate byte-identical.

  Every world-space consumer of element geometry now folds `origin` (`world = origin + position`): camera/scene bounds, the CPU raycast + BVH narrow phase, snap detection, the section cutters (CPU + GPU), the BIM↔scan deviation BVH, the spatial index, clash (world-frame triangles fed to both the TS and Rust kernels), the glTF / IFC5 / Parquet exporters, the Cesium GLB overlay, the construction-projection outline + storey-band derivation, and the federation alignment / mesh-duplicate paths. `MeshData.origin` is serialized in the geometry cache (format version 6, which auto-heals stale entries). Position differences (normals, edge vectors, areas) are origin-invariant and unchanged.

  This composes with the sub-grid sliver hygiene pass: the local frame removes the f32-storage fans, and `Mesh::clean_degenerate` removes the sub-grid slivers the finer-grained CSG host emits.

- Updated dependencies [[`d2086aa`](https://github.com/LTplus-AG/ifc-lite/commit/d2086aa0c5ab5e4d4f98cb25498f58a88c24443c), [`4af01aa`](https://github.com/LTplus-AG/ifc-lite/commit/4af01aabe1c669864c3c3d1757789d7de81beaec), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`02d5ba7`](https://github.com/LTplus-AG/ifc-lite/commit/02d5ba76151bcab80595c8ea80e4046260be73e8), [`977b41d`](https://github.com/LTplus-AG/ifc-lite/commit/977b41db04a83d912f85cc9167cd564ffcb0aafb), [`e42b703`](https://github.com/LTplus-AG/ifc-lite/commit/e42b70324a9d5caab23257d52e96df0198d8caa9), [`16d87f2`](https://github.com/LTplus-AG/ifc-lite/commit/16d87f201dfd7d4cba46bb43e0f4a44ccce717bb)]:
  - @ifc-lite/geometry@2.7.0
  - @ifc-lite/wasm@2.8.1
  - @ifc-lite/spatial@1.14.9

## 1.1.3

### Patch Changes

- [#1071](https://github.com/LTplus-AG/ifc-lite/pull/1071) [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe) Thanks [@louistrue](https://github.com/louistrue)! - Dead-code and dependency hygiene: remove unused internal barrels/shims (clash engine-ts re-exports, collab doc barrel, sdk transport/types) and drop unused dependencies (renderer/cli: @ifc-lite/wasm; cli/mcp: @ifc-lite/encoding; mcp: @types/node out of runtime dependencies; collab: ws devDeps; data: @types/proj4). No public API changes.

- Updated dependencies [[`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`891efef`](https://github.com/LTplus-AG/ifc-lite/commit/891efef5fa9fca04bf2e01be9a1de04bbb84aafe), [`da1999f`](https://github.com/LTplus-AG/ifc-lite/commit/da1999fc6e482fa3d668b9aa98a840d2bb838112)]:
  - @ifc-lite/parser@3.2.0
  - @ifc-lite/geometry@2.6.1

## 1.1.2

### Patch Changes

- [#1036](https://github.com/LTplus-AG/ifc-lite/pull/1036) [`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc) Thanks [@louistrue](https://github.com/louistrue)! - Add a `default` condition to every package's exports map. The maps only
  declared `import` + `types`, so any resolver hitting the CJS/default
  condition path (tsx, jest, plain `require`, some bundlers) failed with
  ERR_PACKAGE_PATH_NOT_EXPORTED. The `default` entry points at the same
  ESM dist file; pure ESM consumers are unaffected.
- Updated dependencies [[`0205c4d`](https://github.com/LTplus-AG/ifc-lite/commit/0205c4d50995572ef796ce66877aa389f19c6fbc)]:
  - @ifc-lite/bcf@1.15.6
  - @ifc-lite/geometry@2.4.1
  - @ifc-lite/ifcx@2.1.4
  - @ifc-lite/parser@3.1.1
  - @ifc-lite/query@1.14.10
  - @ifc-lite/spatial@1.14.8
  - @ifc-lite/wasm@2.5.1

## 1.1.1

### Patch Changes

- [#946](https://github.com/LTplus-AG/ifc-lite/pull/946) [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0) Thanks [@louistrue](https://github.com/louistrue)! - Fix a batch of verified findings from a full-codebase review (security, correctness,
  data-loss, and resource/memory leaks). Highlights:

  **Security**

  - collab-server: a malformed WebSocket frame no longer crashes the whole process
    (decode is wrapped; a bad frame is rejected/audited instead of throwing).
  - mcp: the local HTTP transport now validates `Host`/`Origin` and no longer sends a
    wildcard `Access-Control-Allow-Origin`, closing a DNS-rebinding/CSRF hole; the
    `AuthScope.modelIds` allowlist is now enforced at model resolution.
  - server-bin: `extractZip` uses `execFileSync` (argv, no shell), removing command
    injection via archive/destination paths.
  - export / sdk / cli / mcp / lists / viewer CSV exporters now neutralize spreadsheet
    formula injection (CWE-1236) consistently.
  - create-ifc-lite: validates the project name (no path traversal) and drops the
    unused `execSync`-based downloader.
  - embed-sdk: inbound `postMessage` now validates `event.origin`.

  **Correctness / data-loss**

  - parser: `lengthUnitScale` survives the worker transport; the nested STEP list
    parser is string-aware (commas/parens inside quoted values no longer mis-split).
  - mutations: deleting a property from a session-created pset and replaying
    `UPDATE_ATTRIBUTE` / `CREATE_PROPERTY_SET` mutations now work.
  - export: merged-export ID remapping no longer rewrites `#N` inside quoted strings.
  - drawing-2d: GPU section cutter triangle upload/readback use correct WGSL std-layout
    offsets and strides.
  - ifcx: cyclic children no longer abort the parse; spatial children round-trip; the
    mesh transform guards a zero/non-finite homogeneous `w`.
  - data / cache: a `NULL` string property value stays `null` instead of becoming `""`.
  - pointcloud, bcf, server-client, query, viewer-core, viewer store/federation: assorted
    decoding, federation-id, and selection-state fixes.

  **Resource / memory leaks**

  - geometry, query (DuckDB), renderer (GPU buffers), collab (federation presence),
    sandbox (host log capture + runtime), mcp (clash mesh cache), server-bin (signal
    listeners), and the viewer renderer on unmount now release resources deterministically.

  **Hardening (apps, not published)**

  - server: a dedicated `server-release` Cargo profile (`panic = "unwind"`) plus a
    `CatchPanicLayer` contain a malformed-IFC parse panic to the offending request
    instead of aborting the whole server.
  - desktop (Tauri): a Content-Security-Policy is set, and unused `shell:*` /
    `fs:allow-write|mkdir|remove` capabilities (and the unused shell plugin) are removed.

  **Second pass** (additional verified findings)

  - collab-server: S3 log load now follows `ListObjectsV2` pagination (no dropped frames);
    awareness frames are size-capped + rate-limited; path-lock verify runs after role/rate-limit;
    the blob route requires auth and `/metrics` can be token-gated.
  - server-bin: downloaded binaries are SHA-256 verified against a release sidecar (fail-closed on
    mismatch, warn-if-absent for older releases).
  - extensions: inner-ring capability check fails _closed_ for unknown namespaces; signing
    canonicalization is now injective (length-prefixed).
  - correctness/leaks: mutations quantity type+unit preserved on replay; `findByProperty` boolean
    comparisons; Parquet REAL columns kept as Float64; blob GC fail-safe on missing `uploadedAt`;
    spatial-hierarchy + codegen cycle guards; BVH NaN edge; bSDD/playground caches bounded;
    point-cloud GPU asset freed on federation error; mcp `parseColor` rejects non-hex; bcf/SVG/STEP
    output escaping; and more.

- Updated dependencies [[`b33e1f7`](https://github.com/LTplus-AG/ifc-lite/commit/b33e1f7c4706fe4b0d850d3da782ea84267dd525), [`55fd14e`](https://github.com/LTplus-AG/ifc-lite/commit/55fd14e5017f626567b10622bb41ddac3311e70c), [`6378998`](https://github.com/LTplus-AG/ifc-lite/commit/6378998ec146f7f9297ef5fcc5953b155fd6b5e0), [`ca293ed`](https://github.com/LTplus-AG/ifc-lite/commit/ca293ed7080495b29dd555b191ae0095ff267e4b), [`90060b7`](https://github.com/LTplus-AG/ifc-lite/commit/90060b7eaad7a07bdab13907c1b52bb24fbc8597)]:
  - @ifc-lite/parser@3.1.0
  - @ifc-lite/geometry@2.3.0
  - @ifc-lite/query@1.14.9
  - @ifc-lite/ifcx@2.1.3
  - @ifc-lite/bcf@1.15.5
  - @ifc-lite/wasm@2.3.0
  - @ifc-lite/spatial@1.14.7

## 1.1.0

### Minor Changes

- [#891](https://github.com/LTplus-AG/ifc-lite/pull/891) [`d6b8986`](https://github.com/LTplus-AG/ifc-lite/commit/d6b89866b4c058531ce0c5c7472a297adc6580a8) Thanks [@louistrue](https://github.com/louistrue)! - Add representation-agnostic clash detection.

  `@ifc-lite/clash` is a new package: a source-agnostic clash core (STEP/IFCX
  adapters, BVH broad phase, exact triangle-intersection narrow phase, hard /
  clearance / touch classification) with a pluggable TS reference kernel and a
  Rust/WASM kernel kept in lockstep by a differential test. Results group into a
  _manageable_ set of BCF topics (deterministic topic GUIDs, caps-with-transparency,
  framing viewpoints, A/B coloring, optional snapshots) and round-trip status back.

  Surfaced through the existing tools:

  - `@ifc-lite/clash` — `rulesFromPresets(presets, mode, clearance?, reportTouch?)` builds
    runnable rules from any preset list (the discipline matrix is this over the built-ins),
    so hosts can run a user-curated rule set.
  - `@ifc-lite/viewer` — an interactive clash panel (run detection / discipline matrix /
    presets, A/B highlight + camera framing, configurable settings & custom rules, a
    controllable BCF export with optional rendered snapshots).
  - `@ifc-lite/sdk` — a `clash` namespace (`run`, `matrix`, `group`, presets).
  - `@ifc-lite/cli` — `ifc-lite clash <file>` with `--a/--b`, `--mode`, `--matrix`,
    `--clearance`, `--bcf`.
  - `@ifc-lite/mcp` — `clash_check` (omit selectors for a whole-model self-clash)
    and `clash_matrix`.

  The discipline matrix now threads a `clearance` value onto its rules, so
  `--matrix --mode clearance --clearance N` (and the SDK/MCP equivalents) report
  violations instead of silently dropping the override.

### Patch Changes

- Updated dependencies [[`94d9116`](https://github.com/LTplus-AG/ifc-lite/commit/94d91161abc58b5804bd979d841d7475714ee5ad)]:
  - @ifc-lite/wasm@2.1.1
