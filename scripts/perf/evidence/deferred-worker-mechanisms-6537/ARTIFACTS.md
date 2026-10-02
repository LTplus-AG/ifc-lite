<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Archived artifact index

Generated from the frozen evidence index at `32d2bccaca1a6fe59a11ac5df6765ea70ab057e7`.
All 49 payload bytes are unchanged. Each gzip timestamp is zero. This Markdown
index records integrity and provenance; it is not live configuration or a gate.

Evidence base: `ea2bfce4750aa42dbd0454a9f2691cc14762375d`.
Prototype: `9400cb6c952ba200e165c1dadbd95f9d28fca927` versus
`982da209b3a07da924d4c0af566aebbe7fe749e9`. The browser assets used runtime
`039415545e2448ce8b1e40b14306524ee60cff29dabd97448080ac0d9e170610` on both sides.
Historical build stages remain separately recorded in the qualification payload.
Neither timing attempt completed: v1 retained 11 rows/10 environmentally valid,
and v2 retained 46/45, each out of 50 planned. JSONL objects match the original
per-sample JSON objects; duplicate files are omitted. No Astra transcript is
claimed. Large per-piece arrays and PNGs remain outside this compact archive;
the derived reports do not independently reproduce complete precision/GPU proof.

`Original` below means the exact bytes after **one** gzip decode. For the two
`.json.gz.gz` worker diagnostics, those original bytes are themselves an older
gzip file: decode a second time only to inspect its JSON. The recorded original
SHA and size deliberately cover the original inner gzip, preserving its header.

## Archive bytes

| Payload | Bytes | SHA-256 |
| --- | ---: | --- |
| [affinity-v1/runs.jsonl.gz](affinity-v1/runs.jsonl.gz) | 13607 | `20b9e0c97449a47772fc8f6d0cf3aa67722b4d7733b813ab83ef80db25abcd1e` |
| [affinity-v1/schedule.json.gz](affinity-v1/schedule.json.gz) | 495 | `4ed4e00986156fad4c4bb76a3c09e82b6acf0547eab6dcd704ed5d30fedc7579` |
| [affinity-v1/driver.log.gz](affinity-v1/driver.log.gz) | 750 | `9fc2fa1de3be21f2c85aa226ae504b3a1b3050fc0e635b2dda3c6ac42f1ed970` |
| [affinity-v1/capture.cjs.gz](affinity-v1/capture.cjs.gz) | 4737 | `449a8ce21e40447eed724a6ffc9b3f705d07525d8affee41312aa18721c1d1c8` |
| [affinity-v2/runs.jsonl.gz](affinity-v2/runs.jsonl.gz) | 68784 | `80413d7d1fa370692e9c1e240ab5fe9bcdd98bc83372a85dd3856a78129e0d45` |
| [affinity-v2/schedule.json.gz](affinity-v2/schedule.json.gz) | 495 | `4ed4e00986156fad4c4bb76a3c09e82b6acf0547eab6dcd704ed5d30fedc7579` |
| [affinity-v2/driver.log.gz](affinity-v2/driver.log.gz) | 2290 | `a6af6790626601fdffc144b19e608325a211dcdf00ed0815f79eca29ac3610af` |
| [affinity-v2/capture.cjs.gz](affinity-v2/capture.cjs.gz) | 4737 | `c3f19f184ea2d8e4a9dbcb10b88837183485a66c8283f591f3dd9267e0040a3b` |
| [affinity-v1/incomplete.json.gz](affinity-v1/incomplete.json.gz) | 934 | `b748d27027ed8fa8b82dacf5c77ddd3866dfee64549439d53710b1274929d69f` |
| [affinity-v1/derived.json.gz](affinity-v1/derived.json.gz) | 2433 | `76d82bf485d72dfffbc3279a119d05e2354152c02fd81d131e9316e64d29e73e` |
| [affinity-v2/incomplete.json.gz](affinity-v2/incomplete.json.gz) | 664 | `f1ce066673cacfbad1ce24e6e05ae32e790060d4cf86b26a7f606fc30d3815ab` |
| [affinity-v2/initial-identity-audit.json.gz](affinity-v2/initial-identity-audit.json.gz) | 6958 | `e94036af047f6dc02e19a08bf3bdf029208d351319eb6ac76d4f7a269c925280` |
| [method/native-analyze.py.gz](method/native-analyze.py.gz) | 3825 | `4ca8a12f2d44a3b26aae2efd345cc5ffbf6ab4b9c8d47048ada5a0b6f0336ef6` |
| [review/independent-source-review.md.gz](review/independent-source-review.md.gz) | 2413 | `52cf11ef14aad617eeffd9cbb507c9514402fe342a5a13ef214ef55471a02bd5` |
| [review/trace-summary.json.gz](review/trace-summary.json.gz) | 624 | `cab1f3016154257a4c6c971bf60f27e189c30726a5816e392a6040ed0b781ea1` |
| [review/qualified-prototype.patch.gz](review/qualified-prototype.patch.gz) | 9993 | `f5e41dfbe2bd0520fc7aac54942a667d43417b9ea76e780a29fb1b408256f801` |
| [review/native-harness.patch.gz](review/native-harness.patch.gz) | 2755 | `adbdf3445829f18db5598f5b77ac1957b133a4fdc5b973a07373b04c7d0d3d76` |
| [qualification/qualification.json.gz](qualification/qualification.json.gz) | 1001 | `c569d2a8b3bfa8b6b9f8701a88df98939645b21a6130b95e0393412eff4d3439` |
| [qualification/root-oracle.json.gz](qualification/root-oracle.json.gz) | 392 | `b11fe81f5ea22ed5d8f51246f3f111395422162720201016189fc2a4d9670086` |
| [qualification/normal-green.log.gz](qualification/normal-green.log.gz) | 5764 | `29825d7c7b006a15140d2788857c941ddba3e189ff74152238c3731ef2e1b9f8` |
| [qualification/fullbuild.log.gz](qualification/fullbuild.log.gz) | 20250 | `335bd0b472f497b08cf89eb0a168415b7edc2ad0cb260119bbf31d7368e09db6` |
| [qualification/typecheck.log.gz](qualification/typecheck.log.gz) | 8501 | `4e696c94037c0350e85b3d9e72170816d457979a8be85a7e84aa92b21a5f3aa5` |
| [qualification/root-oracle-green.log.gz](qualification/root-oracle-green.log.gz) | 3839 | `cb133bd342cc78c7cf53da9cf46667b6e3045ef7c5629aaa521dc2b8605a61b0` |
| [qualification/root-oracle-reverted.log.gz](qualification/root-oracle-reverted.log.gz) | 5787 | `b027352d6e0bddf4cd603a640ab83fd0e717c5ec79da4393cadec5a8614daf65` |
| [qualification/root-oracle-restored.log.gz](qualification/root-oracle-restored.log.gz) | 3834 | `059386d1e4ec969e8c10066c8eafd4b7ec4fa9dcc20f0cee6f6a171906dc6adc` |
| [traces/snowdon-v1.json.gz](traces/snowdon-v1.json.gz) | 12656 | `f06bcfdd6ecd622deb5d7abe02e1f168fcc93af36ef35fadbeeb5c60f679c274` |
| [traces/holter-v1.json.gz](traces/holter-v1.json.gz) | 20821 | `b5781a8a6e2d380e4bce1644aff7e549ef473fcc044502118c0f282e7fe78285` |
| [traces/os1-v1.json.gz](traces/os1-v1.json.gz) | 35420 | `16b05a077a657cfeef9834ac8d6196e7476976b8c9b33180168c35962186cd0a` |
| [traces/holter-v2.json.gz](traces/holter-v2.json.gz) | 257241 | `ed287b07e7e44ff20d8cd1d59e2bcbfad941b68407da6ec7b83f14bb6568b290` |
| [compact-source/census-os1.json.gz](compact-source/census-os1.json.gz) | 1305 | `97beea5f9b86f4548dd451887367a40ad8d04495c343ce27c78ff6b238294dc0` |
| [compact-source/census-os1-roots.json.gz](compact-source/census-os1-roots.json.gz) | 138447 | `69f09515dee29dfb54cec5ed620323dd312564219714208147685bf54e8ab1cc` |
| [compact-source/census-os1-provenance.json.gz](compact-source/census-os1-provenance.json.gz) | 1097 | `2c0a515f95c324592341185f303ed78ffca5e2d5737b380714bffe9f9b730568` |
| [compact-source/census-build.log.gz](compact-source/census-build.log.gz) | 156 | `ee77a77daa08ee68f196b873716f634c4932440afad7c79b8b1074828a02efe8` |
| [compact-source/observer.rs.gz](compact-source/observer.rs.gz) | 2711 | `bb2797f6119c587599a7708b2f1e71e879d2e4fab11b685387a2514ad81ab5de` |
| [os1-diagnostic/runs.jsonl.gz](os1-diagnostic/runs.jsonl.gz) | 7707 | `9993a7765dff953bf744a1e538b3b13fad0fede2f32fd31ebfaffd4d8f55c5ab` |
| [os1-diagnostic/schedule.json.gz](os1-diagnostic/schedule.json.gz) | 333 | `014593754b71262fe31d52bfc467d84773d540a5115fa07299825a4e838a169f` |
| [os1-diagnostic/worldgeometry-derived.json.gz](os1-diagnostic/worldgeometry-derived.json.gz) | 1105 | `c8014b16db2e067234e409f2dc3301bda7683478d7f93d06560137bf4f236a9d` |
| [os1-diagnostic/worldgeometry-euclidean-derived.json.gz](os1-diagnostic/worldgeometry-euclidean-derived.json.gz) | 1515 | `8b6eb17921af0c3945cf4e300168f39f1e423136a17aa7c5ec15d216704212f7` |
| [os1-diagnostic/dispatch-and-source-lowerbound-derived.json.gz](os1-diagnostic/dispatch-and-source-lowerbound-derived.json.gz) | 1307 | `825bb5494e907342ccfa090f48c813f2d0b7969a95a2405721896d08aad85ad7` |
| [os1-diagnostic/base-semantic.json.gz](os1-diagnostic/base-semantic.json.gz) | 538524 | `0f65eb1c51fdd00f690dd819095a38dc4bfb9fccdc31bef55522905e38c3a297` |
| [os1-diagnostic/branch-semantic.json.gz](os1-diagnostic/branch-semantic.json.gz) | 538706 | `9b7bc642d4028ceb2037e4bbe5e7b00e6bf7c8b0e30dc67545e4701d54d0d391` |
| [os1-diagnostic/base-worker-diagnostics.json.gz.gz](os1-diagnostic/base-worker-diagnostics.json.gz.gz) | 403560 | `ce91760a61c173b880d182476325194e224aa5147fca66b6f2bbb899e44e1663` |
| [os1-diagnostic/branch-worker-diagnostics.json.gz.gz](os1-diagnostic/branch-worker-diagnostics.json.gz.gz) | 416710 | `2190a7899b0e9815b470028ae7e14dd2903f0602f0f20e19cca58bbc70ef5f24` |
| [method/6537-affinity-worldgeometry-analyze.cjs.gz](method/6537-affinity-worldgeometry-analyze.cjs.gz) | 3338 | `05b89fc21e81534cf8c3e84a2eae1451cdd3df16162924d5ee80802457e7e03e` |
| [method/6537-affinity-worldgeometry-euclidean-analyze.cjs.gz](method/6537-affinity-worldgeometry-euclidean-analyze.cjs.gz) | 3625 | `21dd7ff1da91dc6066812b35d32a9132b6aad0f1322ded7d99dcb83140dd5bd6` |
| [method/6537-affinity-worldgeometry-diagnostic-v1.cjs.gz](method/6537-affinity-worldgeometry-diagnostic-v1.cjs.gz) | 7502 | `ba44d32e925b14d17898a42d13a4362334595b7f5647624abbb36b10722f7ee4` |
| [excluded-diagnostic/runs.jsonl.gz](excluded-diagnostic/runs.jsonl.gz) | 7867 | `28e0b459f1e0e254643936820738d2da634f7ee1ad987cbb9d06ee83ab1798a3` |
| [excluded-diagnostic/schedule.json.gz](excluded-diagnostic/schedule.json.gz) | 333 | `014593754b71262fe31d52bfc467d84773d540a5115fa07299825a4e838a169f` |
| [excluded-diagnostic/first-stage-derived.json.gz](excluded-diagnostic/first-stage-derived.json.gz) | 485 | `f4f5d74c9e0c0b53d0da2db69948d5c4e6c0d76d12cd223e2d486f8f85c849a8` |

## Original bytes and provenance

| Payload | Original bytes | Original SHA-256 | Retained original path |
| --- | ---: | --- | --- |
| `affinity-v1/runs.jsonl.gz` | 129947 | `492ecd71235ad9ee9b6a09e710ce23c41e3f7d189d4d14039a8dec614abfc07e` | `/tmp/6232-takeover/6537-affinity-main940-native-controls-v1/runs.jsonl` |
| `affinity-v1/schedule.json.gz` | 6535 | `d37644beb923b446859ea199047b0b006f4c1cf9b30df042805279c14d2d1e77` | `/tmp/6232-takeover/6537-affinity-main940-native-controls-v1/schedule.json` |
| `affinity-v1/driver.log.gz` | 4655 | `d0771c9f4b6481fe3f0e5fdf8cdb95343cb322b3e7689d5dbe88f993c04b2a97` | `/tmp/6232-takeover/6537-affinity-main940-native-controls-v1.log` |
| `affinity-v1/capture.cjs.gz` | 12682 | `37b11e37bd12242ec0da39b1322cddcff9a380b7659ea7acdc589ba4b55161d1` | `/tmp/6232-takeover/6537-affinity-main940-native-controls-v1.cjs` |
| `affinity-v2/runs.jsonl.gz` | 669757 | `4c47df5c1c0f958845ddbd96ade800fbeb687dd63571c7921f59c6216f19b984` | `/tmp/6232-takeover/6537-affinity-main940-native-controls-v2/runs.jsonl` |
| `affinity-v2/schedule.json.gz` | 6535 | `d37644beb923b446859ea199047b0b006f4c1cf9b30df042805279c14d2d1e77` | `/tmp/6232-takeover/6537-affinity-main940-native-controls-v2/schedule.json` |
| `affinity-v2/driver.log.gz` | 19616 | `f869ef9f08c7a237ee0ccbbdbfe71ebc91b13c0eab4c54c43cc34ff2c518b1e2` | `/tmp/6232-takeover/6537-affinity-main940-native-controls-v2.log` |
| `affinity-v2/capture.cjs.gz` | 12682 | `cc0fad6c76200f963109fa2631aa700e868af0a8a49419beb78c3f273bea50a4` | `/tmp/6232-takeover/6537-affinity-main940-native-controls-v2.cjs` |
| `affinity-v1/incomplete.json.gz` | 2700 | `b377422361877ce8c366000a25ac4279b6c4777994c74163ccff47ad498eb54d` | `/tmp/6232-takeover/6537-affinity-main940-native-controls-v1-incomplete.json` |
| `affinity-v1/derived.json.gz` | 13292 | `c5a306f9b2dd45ba1906cbb37f6394f6a78e47c404fa1770b58ce904d222eb97` | `/tmp/6232-takeover/6537-affinity-v1-root-derived.json` |
| `affinity-v2/incomplete.json.gz` | 993 | `78b9cd6caf6121dbf6fb3d4c524a47c84a1f6e9c5354fe5f4d2bd4d729c9ba94` | `/tmp/6232-takeover/6537-affinity-v2-incomplete.json` |
| `affinity-v2/initial-identity-audit.json.gz` | 58144 | `bffefc3deb679d9ddc5247c4ede2af0b5b2b4c0a652c57e6926e2f89cf2605fd` | `/tmp/6232-takeover/6537-affinity-v2-initial-identity-audit.json` |
| `method/native-analyze.py.gz` | 11608 | `66af55c4ebb2a8d19345a16af83056129331ba929baf2966e0a86a40af7ba35b` | `/tmp/6232-takeover/6537-affinity-native-analyze.py` |
| `review/independent-source-review.md.gz` | 4912 | `4a6ae40d2a5f25279d3776dbcd085cae75089f3b408111d2d4c99e253900fb9b` | `/tmp/6232-takeover/6537-affinity-independent-source-review.md` |
| `review/trace-summary.json.gz` | 4302 | `f750dd3d65ed08835ab35c2476e719aec9fb15a8c35ff91fb6e1df935ebce87a` | `/tmp/6232-takeover/6537-affinity-independent-read-summary.json` |
| `review/qualified-prototype.patch.gz` | 37232 | `f17e131bf3e25bbc18c7f89978025d7c01e38c1627ab752a03441e85b6d28f67` | `/tmp/6232-takeover/affinity-admission-main940-source-review.patch` |
| `review/native-harness.patch.gz` | 7169 | `a193a7dae53c92183b5d0ce4e6c1608b41f413405c94e3a26a3f1746f22d467e` | `/tmp/6232-takeover/6537-affinity-native-harness-review.patch` |
| `qualification/qualification.json.gz` | 2374 | `ec5bee8eaaf98487c48bdf54a47e553b9b512b68c194c9793f54030cda9dbf08` | `/tmp/6232-takeover/affinity-admission-main940-qualification.json` |
| `qualification/root-oracle.json.gz` | 908 | `daa267194fcf00ac3dfd7b1f6532e61140777f463dfeab6cb2d58452845dd9f1` | `/tmp/6232-takeover/affinity-admission-main940-root-oracle.json` |
| `qualification/normal-green.log.gz` | 80430 | `9bdeef626e3bdabdf6d4a940a3bb0fa4981d49d07a886d0fbbc0b1b380949b2b` | `/tmp/6232-takeover/affinity-admission-main940-normal-green.log` |
| `qualification/fullbuild.log.gz` | 112876 | `73873675fe821e90dc0fbb97581a1308c560d2f1725a0ef3ca854b7874d7404c` | `/tmp/6232-takeover/affinity-admission-main940-fullbuild.log` |
| `qualification/typecheck.log.gz` | 56420 | `25ca66e9cdf6f9fbee51e14d4d426dcf50fb4fe87003bf937f06e729ad688cb8` | `/tmp/6232-takeover/affinity-admission-main940-typecheck.log` |
| `qualification/root-oracle-green.log.gz` | 35513 | `8067134f8bcf0060d216e7a7e0e510a6e63bdc05791ac62d64fd2db18bfafce7` | `/tmp/6232-takeover/affinity-admission-main940-root-oracle-green.log` |
| `qualification/root-oracle-reverted.log.gz` | 56089 | `ed63ff7089b14e2b99d569e8c553fcf28cf1fe8e4b1ca8a994c69e5a2d66deaa` | `/tmp/6232-takeover/affinity-admission-main940-root-oracle-reverted.log` |
| `qualification/root-oracle-restored.log.gz` | 35532 | `d824d97fcfa70c941f05c91c9fa78e834b5071c9815806f63f8d81aafe3c3d11` | `/tmp/6232-takeover/affinity-admission-main940-root-oracle-restored.log` |
| `traces/snowdon-v1.json.gz` | 137445 | `ba23eea789a988ef3fd3dbf9e060207dd3511769403b37ea0681e63e1d751555` | `/tmp/6232-takeover/6537-current-main-snowdon-affinity-trace-v1/trace.json` |
| `traces/holter-v1.json.gz` | 214254 | `280bc136f45f4dfabaecdb720f94db3228159046acc9770d932a00c8c26062ff` | `/tmp/6232-takeover/6537-current-main-holter-affinity-trace-v1/trace.json` |
| `traces/os1-v1.json.gz` | 351548 | `bc92c552e5a143562cb37e70b2100d971fd05370394f91e5fe876295760bb0c4` | `/tmp/6232-takeover/6537-current-main-os1-affinity-trace-v1/trace.json` |
| `traces/holter-v2.json.gz` | 2955618 | `3d082297286b7128156f3796863e10ea1e6860912b1f57af186bea2e7ae179fc` | `/tmp/6232-takeover/6537-current-main-holter-affinity-trace-v2/trace.json` |
| `compact-source/census-os1.json.gz` | 6126 | `07cb338ce803efb807877bd503b087f112db98d73c2b5b1dbbdc53237b6de74d` | `/tmp/6232-takeover/6537-worker-forward-source-census-os1.json` |
| `compact-source/census-os1-roots.json.gz` | 573271 | `6138d0e31e8348d743d3272a90b8a8c69b8a316e3b40753869b632cbb804b4e6` | `/tmp/6232-takeover/6537-worker-forward-source-census-os1-roots.json` |
| `compact-source/census-os1-provenance.json.gz` | 2421 | `17535dc75113f710dd5f5289b6b7c6883a3e65fbfbc7420996f27da338f00ed7` | `/tmp/6232-takeover/6537-worker-forward-source-census-os1-provenance.json` |
| `compact-source/census-build.log.gz` | 172 | `6d84c9d4847ee3781a3ad9c035989c671c51837ad074aa219de081db6ef9425b` | `/tmp/6232-takeover/6537-worker-forward-source-census-build.log` |
| `compact-source/observer.rs.gz` | 6886 | `6911568675981156d20892757d13ddda46ffc8ff8e3686b8ee99f32e10dc5e0d` | `/home/louistrue/wt/6537-prepass-census-session6503/rust/processing/examples/worker_forward_source_census.rs` |
| `os1-diagnostic/runs.jsonl.gz` | 34133 | `2b78b6576eded302dfd9f6b5ccef82f20ccdb32fb4200769bc66cb3701f17c76` | `/tmp/6232-takeover/6537-affinity-worldgeometry-diagnostic-v1/runs.jsonl` |
| `os1-diagnostic/schedule.json.gz` | 591 | `6706b7573647bf779596ef4c95989d28905bbeadc3185c73fd948cf9744a2fe2` | `/tmp/6232-takeover/6537-affinity-worldgeometry-diagnostic-v1/schedule.json` |
| `os1-diagnostic/worldgeometry-derived.json.gz` | 5402 | `2b6de44f17672e1b0bba369ab63c302305ebdf6a8f4f26bfa54df8787c301e1e` | `/tmp/6232-takeover/6537-affinity-worldgeometry-diagnostic-v1/worldgeometry-derived.json` |
| `os1-diagnostic/worldgeometry-euclidean-derived.json.gz` | 7501 | `c3b11ce07193703727f17d4dfad759514e3bf7fc4d9123e23df385d61b13c464` | `/tmp/6232-takeover/6537-affinity-worldgeometry-diagnostic-v1/worldgeometry-euclidean-derived.json` |
| `os1-diagnostic/dispatch-and-source-lowerbound-derived.json.gz` | 8526 | `5db90c11318763fef6e71b4290e96da66df50a51887a9379f90eea7dbd6881e5` | `/tmp/6232-takeover/6537-affinity-worldgeometry-diagnostic-v1/dispatch-and-source-lowerbound-derived.json` |
| `os1-diagnostic/base-semantic.json.gz` | 14641569 | `d40c99a0edaa7b86014898ed5b8110934493acbedf9d0bc0e01f12eb0d3b05de` | `/tmp/6232-takeover/6537-affinity-worldgeometry-diagnostic-v1/base-semantic.json` |
| `os1-diagnostic/branch-semantic.json.gz` | 14680310 | `f1b35e2350fe98767b17aedc60a4f81be619ec6f4e4e11af50a86a9065506f16` | `/tmp/6232-takeover/6537-affinity-worldgeometry-diagnostic-v1/branch-semantic.json` |
| `os1-diagnostic/base-worker-diagnostics.json.gz.gz` | 403417 | `62c14074acfc7460974d2027744f578e27a90f83ce4d8fc8d02e9f3d2eb38a5b` | `/tmp/6232-takeover/6537-affinity-worldgeometry-diagnostic-v1/base-worker-diagnostics.json.gz` |
| `os1-diagnostic/branch-worker-diagnostics.json.gz.gz` | 416562 | `00d8debcd90cbf06f0d37a10697139b68ce6e984bf351250d3971a12405126ef` | `/tmp/6232-takeover/6537-affinity-worldgeometry-diagnostic-v1/branch-worker-diagnostics.json.gz` |
| `method/6537-affinity-worldgeometry-analyze.cjs.gz` | 9929 | `a3978132227b83389b4a96cabc82f4c12fd5c29e6f587a9d027766e290df27b2` | `/tmp/6232-takeover/6537-affinity-worldgeometry-analyze.cjs` |
| `method/6537-affinity-worldgeometry-euclidean-analyze.cjs.gz` | 10800 | `a023daa7569f88cff5b59404fa18e62c2a30d857bcf4552410e0dca8a379b5ef` | `/tmp/6232-takeover/6537-affinity-worldgeometry-euclidean-analyze.cjs` |
| `method/6537-affinity-worldgeometry-diagnostic-v1.cjs.gz` | 21774 | `59bb38d47b62c7a4a10eab80ecb80634e3471a177125cc309890079bc1dc0a5d` | `/tmp/6232-takeover/6537-affinity-worldgeometry-diagnostic-v1.cjs` |
| `excluded-diagnostic/runs.jsonl.gz` | 34897 | `f2dbb840739990e02c0680e26637224f3916c392d7007cac6483acd5e1486ffb` | `/tmp/6232-takeover/6537-affinity-fullscene-diagnostic-v1/runs.jsonl` |
| `excluded-diagnostic/schedule.json.gz` | 591 | `6706b7573647bf779596ef4c95989d28905bbeadc3185c73fd948cf9744a2fe2` | `/tmp/6232-takeover/6537-affinity-fullscene-diagnostic-v1/schedule.json` |
| `excluded-diagnostic/first-stage-derived.json.gz` | 1240 | `fc8eeb14cb305295b47cff31a3bb2a42d7c2a94b119e43ccff46e162d5fe49a6` | `/tmp/6232-takeover/6537-affinity-fullscene-diagnostic-v1/first-stage-derived.json` |

## Recorded artifact scopes

- `affinity-v1/runs.jsonl.gz`: original incompletecohort, preserveallrows/order/failure.
- `affinity-v1/schedule.json.gz`: original incompletecohort, preserveallrows/order/failure.
- `affinity-v1/driver.log.gz`: actual originalcapture/log; historical paths notportable newexecution.
- `affinity-v1/capture.cjs.gz`: actual originalcapture/log; historical paths notportable newexecution.
- `affinity-v2/runs.jsonl.gz`: original incompletecohort, preserveallrows/order/failure.
- `affinity-v2/schedule.json.gz`: original incompletecohort, preserveallrows/order/failure.
- `affinity-v2/driver.log.gz`: actual originalcapture/log; historical paths notportable newexecution.
- `affinity-v2/capture.cjs.gz`: actual originalcapture/log; historical paths notportable newexecution.
- `affinity-v1/incomplete.json.gz`: original recorded review/qualification; not fresh execution.
- `affinity-v1/derived.json.gz`: original recorded review/qualification; not fresh execution.
- `affinity-v2/incomplete.json.gz`: original recorded review/qualification; not fresh execution.
- `affinity-v2/initial-identity-audit.json.gz`: original recorded review/qualification; not fresh execution.
- `method/native-analyze.py.gz`: original recorded review/qualification; not fresh execution.
- `review/independent-source-review.md.gz`: original recorded review/qualification; not fresh execution.
- `review/trace-summary.json.gz`: original recorded review/qualification; not fresh execution.
- `review/qualified-prototype.patch.gz`: original recorded review/qualification; not fresh execution.
- `review/native-harness.patch.gz`: original recorded review/qualification; not fresh execution.
- `qualification/qualification.json.gz`: original recorded review/qualification; not fresh execution.
- `qualification/root-oracle.json.gz`: original recorded review/qualification; not fresh execution.
- `qualification/normal-green.log.gz`: actual original qualification output; source982.
- `qualification/fullbuild.log.gz`: actual original qualification output; source982.
- `qualification/typecheck.log.gz`: actual original qualification output; source982.
- `qualification/root-oracle-green.log.gz`: actual original qualification output; source982.
- `qualification/root-oracle-reverted.log.gz`: actual original qualification output; source982.
- `qualification/root-oracle-restored.log.gz`: actual original qualification output; source982.
- `traces/snowdon-v1.json.gz`: instrumented singleload diagnostic, not throughput proof.
- `traces/holter-v1.json.gz`: instrumented singleload diagnostic, not throughput proof.
- `traces/os1-v1.json.gz`: instrumented singleload diagnostic, not throughput proof.
- `traces/holter-v2.json.gz`: instrumented worker source-key trace, notcostproxy.
- `compact-source/census-os1.json.gz`: original canonical syntacticforward census; not runtimeaccessunion/safepacket proof.
- `compact-source/census-os1-roots.json.gz`: original canonical syntacticforward census; not runtimeaccessunion/safepacket proof.
- `compact-source/census-os1-provenance.json.gz`: original canonical syntacticforward census; not runtimeaccessunion/safepacket proof.
- `compact-source/census-build.log.gz`: original canonical syntacticforward census; not runtimeaccessunion/safepacket proof.
- `compact-source/observer.rs.gz`: original diagnostic source, no new parser or production source.
- `os1-diagnostic/runs.jsonl.gz`: original instrumented semantic/geometry diagnostic; not timedcohort or precision-gate execution.
- `os1-diagnostic/schedule.json.gz`: original instrumented semantic/geometry diagnostic; not timedcohort or precision-gate execution.
- `os1-diagnostic/worldgeometry-derived.json.gz`: original instrumented semantic/geometry diagnostic; not timedcohort or precision-gate execution.
- `os1-diagnostic/worldgeometry-euclidean-derived.json.gz`: original instrumented semantic/geometry diagnostic; not timedcohort or precision-gate execution.
- `os1-diagnostic/dispatch-and-source-lowerbound-derived.json.gz`: original instrumented semantic/geometry diagnostic; not timedcohort or precision-gate execution.
- `os1-diagnostic/base-semantic.json.gz`: original instrumented semantic/geometry diagnostic; not timedcohort or precision-gate execution.
- `os1-diagnostic/branch-semantic.json.gz`: original instrumented semantic/geometry diagnostic; not timedcohort or precision-gate execution.
- `os1-diagnostic/base-worker-diagnostics.json.gz.gz`: lossless outermtime0 gzip of original retained workerdiagnosticsgzip.
- `os1-diagnostic/branch-worker-diagnostics.json.gz.gz`: lossless outermtime0 gzip of original retained workerdiagnosticsgzip.
- `method/6537-affinity-worldgeometry-analyze.cjs.gz`: original independent diagnostic method; no newexecution.
- `method/6537-affinity-worldgeometry-euclidean-analyze.cjs.gz`: original independent diagnostic method; no newexecution.
- `method/6537-affinity-worldgeometry-diagnostic-v1.cjs.gz`: original independent diagnostic method; no newexecution.
- `excluded-diagnostic/runs.jsonl.gz`: earlier two-load attempt withcontaminated secondrow; notperformance evidence.
- `excluded-diagnostic/schedule.json.gz`: earlier two-load attempt withcontaminated secondrow; notperformance evidence.
- `excluded-diagnostic/first-stage-derived.json.gz`: earlier two-load attempt withcontaminated secondrow; notperformance evidence.
