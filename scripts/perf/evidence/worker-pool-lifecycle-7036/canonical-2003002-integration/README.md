# Canonical current-main prerequisite qualification (#7180)

Frozen main 2003002f79e6a60ea25be2ec45ebe362ab3c1c8a normally integrated at source 065e386acfeb9b35c6685b805b48a186b6693933 without conflicts. Canonical #7233 adds the actual tests/evidence/** trigger; the existing benchmark route remains. The broader tests/** experiment was superseded and never committed or published.

Actual qualification: 63 prerequisite controls, unchanged 42 CI path-coverage controls, 74 affected real-fixture viewer controls, all with zero failures/skips. The actual CI path gate covers 147 gates, 58 jobs and 606 inputs with 49 existing reasoned exemptions. Plain full root typecheck includes all 3,739 test files across 62 packages. Six necessary light gates pass.

The qualification manifest pins 30 source files and 13 raw/compressed archive pairs; decompression reproduces raw hashes and lengths. Twenty actual selected test-process records pair ten PIDs; all record b335… WASM. Earlier/later phase artifacts remain separately recorded. Root independently verified the archive, current pins, counts and process pairs.

This qualifies the standalone bounded prerequisite harness and its current-main integration. It supplies no production worker-pool implementation, completed full-native output/census acceptance, speed result, scheduler installation or external/human acceptance. Prior source evidence stays historical. The final commit only adds this finite evidence archive.
