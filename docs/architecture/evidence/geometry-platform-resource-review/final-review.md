# Final resource delivery review

Read-only inspection of child HEAD `717a386c6aaff2eb3bfd30094d49e73f06208693` and delivered source checkpoint `5a4d1edd914a13e4bac7320bf91482f9b0a2e229`. All 45 paths in files.json match their delivered after_sha256 values. No edits, builds, tests, new jobs, or compiled probes were performed. Descriptions of test behavior below are static inspection, not executed results.

## Remaining concrete objection: a previously stopped Compatibility ancestor can be hidden by a fresh worker epoch

`rust/core/src/execution_owner/resource_context.rs:33-35` checks only the handle's own WorkEpoch.resource_stop. It does not check parents. Each new work scope initializes its own resource_stop to None (`execution_owner.rs::ExecutionWork::child_capability`) even if an ancestor has already stopped.

The distinguishing scenario is CROSS-THREAD, not ordinary same-thread reentry:

1. Execute an actual outer extrusion callback through the accounted adapter under Compatibility.
2. Inside that callback call resource::stop(Cancelled), catch it, then lend the actual decoder to a scoped worker.
3. The worker enters the borrowed canonical producer for a real child slab with a fresh router. Worker TERMINAL TLS starts empty, while the actual decoder transports the stopped ancestor source capability.
4. `session_canonical.rs:88-98` installs the ancestor SOURCE_STOP but, because its resource context is None, directly invokes the operation. There is no admission check that latches the old stop before child planning.
5. Planning/execution ProductOwner.work installs a fresh child SOURCE_STOP whose own resource_stop is None. `resource::check_current` sees neither an active account failure nor worker TERMINAL failure, and its source check misses the stopped ancestor. The child's geometry callback and cache effects can run after the outer terminal.
6. Restoring the ancestor source handle eventually observes the stop, and the outer accounted adapter still returns Cancelled. Thus this is unwanted descendant execution after a terminal, not a claim that the outer adapter publishes success.

Same-thread reentry remains protected by TERMINAL TLS; it must not be used as the purported reproduction. Existing worker tests stop INSIDE the child callback; they do not cover a stop already recorded before the new worker/epoch enters.

Narrow recommendation: make SourceStopHandle::check consult the ancestor chain and preserve its established first-fault result. Consider a reached canonical admission check before planning as appropriate without changing the borrowed public return ABI. Add an actual callback test: stop in the Compatibility parent, then invoke a real scoped-worker child; require zero child numerical callback invocations/cache publication and outer typed Cancelled. Cover a prior ResourceRefused followed by a different attempted child stop to verify first-fault identity. This is a source-grounded proposed invariant, not an executed reproduction.

## Earlier objections resolved on their reviewed paths

- Direct public ExecutionAccount::prepare failures now route through resource::stop, and charge normalizes failure too. A nested fresh bounded refusal cannot disappear merely when CURRENT restores to Compatibility. The new actual extrusion test covers both prepare and charge forms in source, but was not run by this reviewer.
- ProductOwner work/read_work publish the actual source-borrow scope with the current account context and install its source stop handle. Canonical borrowed, owned and accounted entries recover that context from an actual validated decoder source lease. Only resources transfer; kernel/diagnostic/census TLS remains separate.
- Scoped workers with Compatibility parents transport a source stop even without a bounded account. A stop raised inside the child's current epoch propagates to its ancestors, so the accounted parent's return check observes it.
- Canonical source-context installation precedes worker-supplied account.scope. ExecutionAccount::source_scope replaces unrelated worker CURRENT with the actual bounded source account and restores the old account on normal return/unwind. The previous early-return-on-is_active bypass is removed.
- The local hash-cache move now uses resource::mesh::resident_bytes, checking positions/normals/indices/plane-tag CAPACITIES before cache publication. Copy accounting continues to use initialized lengths. Real-extrusion spare-capacity coverage exists in source, unexecuted by this reviewer.

## Scope and integration limits

Compatibility installs no bounded account or new quota. Ordinary borrowed/custom/scoped-worker calls that never invoke explicit resource stops retain numerical dispatch and owner semantics on inspection. The existing default allocation-free ExecutionOwner construction stays lazy; resource fields live in already allocated work epochs. Strict creates an UnsupportedCoverage refusal before producer invocation. Bounded outputs explicitly remain resource-unqualified: opaque source/decoder/profile/kernel/assembly/raster allocations and downstream copies are excluded, so this review makes no complete heap, RSS, geometry-coverage or performance claim.

Local/shared cache owners retain account clones before payload publication; independently completed cache effects survive a later branch failure. Charging is conservative and can retain discarded/replaced allowances until owner destruction. This is not exact reconciliation. Resource sidecars and output wrapper exclusions remain explicitly documented.

The delivery targets the reconstructed historical source. Its router/mapping hunks must be ported into the parent's sole program/mapping implementation, without recreating a second mapping path. The terminal checks must surround the parent's actual selected lower_owned and RTC fallback seam; copying the old process-only dispatch extraction would discard newer production ownership work. Source-owner lifecycle errors and presentation admission must be reconciled on the actual parent after integration. No claim of successful integration is made here.

Public SourceStopHandle is cloneable and retains an epoch Arc; its check/stop methods do not themselves validate epoch activity. The transport entry obtains it through a validated source lease, which covers the reviewed live synchronous path. If independent handle use is intended as a future authenticated capability API, expiry semantics need a separate explicit contract; this review does not treat arbitrary caller-installed handles as an established transport/security guarantee.

## Exact inspected hashes

Incremental patch SHA256: `d23aa8ef1e3d8af2d0ce6eed1ea7a2600458c1139c1f2cbbc1aa7681da11e9b5`.

- `docs/architecture/geometry-platform-resource-accounting.md`: `fdb48febb4097f56c71ac271739763dc86fb126e5c9ef22425a094b5e72ec167`
- `docs/guide/geometry.md`: `951565fba9e1e0c5fa11b3c2f7079b792c03a0254cd7c18df6234f810951ca1d`
- `rust/core/src/execution_owner.rs`: `e38ffab725f51a3b047cdd77ee6a00716d3aac3c2e7f2901588406e4b86b9aca`
- `rust/core/src/execution_owner/resource_context.rs`: `4d1d827100d4b8ae7a697b5fb75701428bdce8b175ccf42ee296b45e996c66ba`
- `rust/core/src/lib.rs`: `8278bb9e51eb4106cacd5ff897f445af540bb4550193ed5eecc67be545b52821`
- `rust/core/src/resource_stop.rs`: `71e33810e5f7802b76e5ba89905460015ee3557a663555c8e371f391be4a486c`
- `rust/geometry/src/error.rs`: `b2d0294aa8245782d0dbde463129381b2a0cb8cb27fab42634aca8bd0352986c`
- `rust/geometry/src/lib.rs`: `1ecdf7815ecfa74a629a11b779788084b222481367de47466fe37ba04d328edb`
- `rust/geometry/src/resource/account.rs`: `726899edc5817be234f93b4dc28a3f7fa16181449d6fcef8e4b63b209a27846e`
- `rust/geometry/src/resource/mesh.rs`: `a988cfddc48dca2a5e1da7a2e8a2c8a7ade7b41787249d9f608fc4ac57f47e0d`
- `rust/geometry/src/resource/mesh_tests.rs`: `1ee17e7e1e483019c7586ae2196b2aa7b470b8efb3c8c33668f784b72a00bb4a`
- `rust/geometry/src/resource/mod.rs`: `ace314d04383e4ec6863c36f904eff72b163ba8cb2aa2953f8c0efb1d78725ae`
- `rust/geometry/src/resource/pool.rs`: `d2d1d8e29747d3171cced8ff66d2c3ed19fb8b4a73528b57a419550744b43c5a`
- `rust/geometry/src/resource/storage.rs`: `44d279e0d4333a1a1901e3bb6afdbaf4177c216b59e8ea491216f8bd721fcc4a`
- `rust/geometry/src/resource/tests.rs`: `ff414d6b53e1966759f9b798bc114714b65bbec77a1c178b746434c5ac9e11f3`
- `rust/geometry/src/router/frame_parts.rs`: `348b0ca83add7c0d2d28c9371ac52c231f60cf7e28d9a47d7930733bba7d2c73`
- `rust/geometry/src/router/frame_parts_tests.rs`: `f12bc800dbf75b35dcfd955d33e7c05e1af4c6dc88705b8714a0f5d3d1576a82`
- `rust/geometry/src/router/instancing.rs`: `fed535b2577e576ccf944d4009f37a6419a9aebcb76f67e3610cbfb16e892d2e`
- `rust/geometry/src/router/mapped_cache_ownership.rs`: `9dce7b1589d64b96807ddeab3c832f9ca12e9e113bcd73753c19eebf2c343f10`
- `rust/geometry/src/router/mapped_cache_ownership_tests.rs`: `a0c6d73266eb67be483a374f29d824f9483e86b3a25c6617d3be61b108eb11a1`
- `rust/geometry/src/router/mapped_item.rs`: `cffa7c0441ba22ebf8af32c2cf544321dfe6f8576297cfb6537328274f7e86d8`
- `rust/geometry/src/router/mapping/merged.rs`: `1378973ba12d1e8343960b9886bdd03de727cc72428b70cb4768c0b7ca10c602`
- `rust/geometry/src/router/mapping/mod.rs`: `ada7bcf1d02766a047dc1b718a236c07ee2b2075eb18f3d9455e220270d714e4`
- `rust/geometry/src/router/mapping/occurrence.rs`: `a3e79ff9895d8db780c799f2c4cce2a2a5bea7eed5e85aff17d8787417e0e3a2`
- `rust/geometry/src/router/mapping/resource_tests.rs`: `1338cf65c8e5ccc3d16e331f8e29772629e145c21783efdedd80e17353706a01`
- `rust/geometry/src/router/mapping/submeshes.rs`: `2ddc746c76d2ecaf8e1dc0a7817e6b0218d4647357359a0a742a8c18c5c85554`
- `rust/geometry/src/router/mapping/tests.rs`: `135a60c833c265250b53103a936e9a8bc2cc9f886666f79dd212c279de6af174`
- `rust/geometry/src/router/mod.rs`: `4e68e75b20655ee1fc73041f72831fffd948eda69945e01b49c5c56ee7aca72a`
- `rust/geometry/src/router/processing.rs`: `bec92d8af5927a6ac10a249f75e71ada54068494fbfd6c51596365f86a2b71e9`
- `rust/geometry/src/router/processing_items.rs`: `6630f3a080b02371781bceb7d67a8ee42c4fd8d46044775a33a31831e100943a`
- `rust/geometry/src/router/rtc_terminal_tests.rs`: `da061065594ff0da8108870f3c6ce4d0d9e2fffcb770b9e755d52d7c1e87fe55`
- `rust/processing/src/element.rs`: `d1138c00e238b92507c3bf79134a604b84da0f68490886369910f8bfe9c913ae`
- `rust/processing/src/element/accounted_protocol_tests.rs`: `6db4c84697f29b59a79338a762aac116788f2178dba3e33d9e07ad7026b6aacb`
- `rust/processing/src/element/accounted_session.rs`: `47183ec80b8a7970b215fbc89438380e469c740b142cb0426e015a5b1e9e86a2`
- `rust/processing/src/element/accounted_session_tests.rs`: `6d468b6317688a20bd658719d525ba6701ca30d130cfca05255f743e4290f7e8`
- `rust/processing/src/element/accounted_threaded_tests.rs`: `59b3e484a0c986bb345fee69c97f9672594b5ce51c7d2220b0bbcc240964da03`
- `rust/processing/src/element/owned_session.rs`: `c7a9b9a17890905be94b9c231fd2ec7d8569de7b8d953da2f15c2a718d61d40a`
- `rust/processing/src/element/session_accept.rs`: `5f7d5b079af7ff99c5d1a5240d895895c434e9272ec2736808bb0ab5f69af7f3`
- `rust/processing/src/element/session_canonical.rs`: `fc48961876f01c265bc22ffa89a38af3ad5dfeb1cb6a3494e97dcf3261708a02`
- `rust/processing/src/element/session_owner.rs`: `2ddea677fb77d972daec4adac01ff773515ecf94a8d747b888e464801a621c50`
- `rust/processing/src/element/session_protocol.rs`: `6cde3eaa6b44878b95a16e9d48436298d226b55349160c1e1f753e93657cff4d`
- `rust/processing/src/element/session_work.rs`: `e22535184636846eda07975ae2e1e5a1b11dcdbe2883d34d2d4ef132677721ad`
- `rust/processing/tests/module_size_allowlist.txt`: `fcec1503dac41d82b3c1909d7b72eefed36fa31ae854f70add30055df07f41b2`
- `rust/processing/tests/module_size_ratchet.rs`: `540f163b6298f8c7d4dabbad4223088608531c30fbb1488e3600852649138167`
- `scripts/perf/README.md`: `45b65b7a0e55803ec5e2afed57e8790e9d510c3ab5e36ea0a696c7b56a861914`
