# Native preparation test deadline (#6232)

Original logs and large JSON are losslessly gzipped with timestamp zero. `hashes.json` binds the original and archived bytes, literal source identities, runtime and execution scopes.

The new eight two-model fault/recovery integration controls now have a finite 30-second test deadline. The last two input-only controls retain the default. Production, every assertion, request deadlines, global configuration and native job selection are unchanged.

## Actual failure and qualification

- Two full-CI executions exceeded the default 5,000 ms: #6760 at 5,192 ms and #6761 at 5,299 ms. These were test deadline failures, not observed error-classification or graph mismatches.
- The first local no-build diagnostic used stale sibling declarations/runtime code and failed because `getMutationRevision` was absent. It is retained as an inconclusive prerequisite failure, separate from the corrected root Turbo dependency build and ten passing controls.
- The immutable owning leaf and combined execution results below are literal source-labelled runs; no performance claim or current-head CI substitution is made.
- No browser suite was recaptured for this test-only change. Original late Room captures remain source 902684/tree e542 and six other retained suites remain e98, as documented in `../room-review-lifecycle/`.

## Sources

Owning leaf: `90ae64e266486a19f8a65ac01e99af32eda70f46`.
Combined execution: `dc04b1ef80961ee9d372170c1dd9e76ca08bf7f2`, tree `8fb30482a12408aa5ce02b881f04345ab9140209`.

## Original artifacts

- [6232-6760-bffa-node-failure.log.gz](6232-6760-bffa-node-failure.log.gz): Original current #6760 full-CI 5,192 ms default-deadline failure; original SHA-256 `ecd0165f2ae624094ec4ba90b3c6835890fa5f0bf48c42f71f6f3ee72db38119`.
- [6232-6761-59f42-node-failure.log.gz](6232-6761-59f42-node-failure.log.gz): Original current #6761 full-CI 5,299 ms default-deadline failure; original SHA-256 `59af631452bec48cba20ce4c6905e537b0184129f221080deb5367907706445c`.
- [6232-6761-room-preparation-timeout-diagnostic.log.gz](6232-6761-room-preparation-timeout-diagnostic.log.gz): INCONCLUSIVE first --only diagnostic with stale sibling build output; original SHA-256 `1e4196269b4d019dfbe484a2b20f7b264e01746853d1b684c86b98d310a44f01`.
- [6232-6761-room-preparation-prerequisites.log.gz](6232-6761-room-preparation-prerequisites.log.gz): Corrected old-deadline exact 59f source: root Turbo 39-task prerequisite/test run, ten passes; original SHA-256 `26a21b68e93b82183ce68bee2a090e9b2488fed672a263cfec470ecf8b41c1c6`.
- [6232-6761-room-preparation-timeout-diagnostic-corrected.log.gz](6232-6761-room-preparation-timeout-diagnostic-corrected.log.gz): Corrected exact 59f source: forced no-build ten passes after prerequisites; original SHA-256 `5316b7d6bdcbfb5453ac4ad33e50d84b659dc8d31bd4b891b9ef104f3774e0c6`.
- [6232-room-preparation-native-timeout-diagnosis.json](6232-room-preparation-native-timeout-diagnosis.json): Literal original source/runtime and diagnosis hashes; original SHA-256 `08325172e3d6e9194d05499b07da9305a246f521b1284b16cb129949dbaf8eba`.
- [6232-native-preparation-budget-receipt.json](6232-native-preparation-budget-receipt.json): Owning 90ae source qualification: ten controls and 111-task types /3389 test files; original SHA-256 `cbcb3214a345e3934c87bda2cbc146924c61c63b78b70873b11100c0593e1ded`.
- [6232-native-preparation-budget-tests.log.gz](6232-native-preparation-budget-tests.log.gz): Owning repaired 90ae source root Turbo39-task ten-pass cohort; original SHA-256 `b30be45ed2a9a5468f05c1ffc6dbe2134265350ebec53afb79d924f9c30e1153`.
- [6232-native-preparation-budget-types.log.gz](6232-native-preparation-budget-types.log.gz): Owning repaired 90ae source mandatory typecheck111/3389, 63 cached tasks; original SHA-256 `b1e6c1b680b1991fb11c3931953554f6c8fbbecb4af73fb56cf64f38acb48c76`.
- [6232-native-preparation-budget-integrated-receipt.json](6232-native-preparation-budget-integrated-receipt.json): Combined dc04 source qualification and ancestry-only886 identities; original SHA-256 `e6f63bb1f0e574bbd8e9b4c9e946fa2bab34e24e37d8b83eab003bdca72ad775`.
- [6232-native-preparation-budget-integrated-types.log.gz](6232-native-preparation-budget-integrated-types.log.gz): Combined dc04 root mandatory typecheck111/3399,106 cached tasks; original SHA-256 `6343803dd2ca548963f4ea391586ddbb6c5a95248f08cff71e05177a160d0f94`.
- [6232-native-preparation-budget-integrated-controls.log.gz](6232-native-preparation-budget-integrated-controls.log.gz): Combined dc04 exact ten native controls PASS,zero skips/test cache; original SHA-256 `e36afeeadcff536bb18f6fa1e13ba437ab45d1c67b3d90e6ad1842aecda7927b`.
- [6232-native-preparation-budget-three-forward.json](6232-native-preparation-budget-three-forward.json): Exact one-test-only three-layer forward/source/API/upper own patch/live main tree proof; original SHA-256 `7ead85850710f8d9dce2207abf08a93d53f81e342f73918d1d86eb296f6aed21`.
