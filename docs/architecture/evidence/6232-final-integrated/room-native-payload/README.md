# Native Room cache payload assertion

Review feedback on #6757 identified an inherited #6754 test gap: the carried cached face array could equal its source while the duplicated native plate lost the split. Exact source `1ce9605e2febe22a40f34200ac056f3bc79299d2` changes one assertion to compare `readFaces(carried.plate)` with the validated cut faces. The existing native reader is reused; production is unchanged.

Forced root Turbo execution of `room-read-native.test.ts` passes all three controls with zero skips. A temporary production mutation deliberately reinitializes the carried native plate from the original wall rectangles, losing the split. The old cached-array assertion still passes all three controls; the stronger native-payload assertion fails one control (expected two faces, actual one) while the other two pass. Production is restored after the experiment. This deliberate counterexample qualifies the assertion, not an observed shipped geometry regression.

Original logs are retained losslessly with compressed and raw hashes in `archive.json`. The matching runtime before and after is WASM `7d63d9bc94333f10c4044eac3f70bd86bf361b98659ff5e6cb1161def46f597b`, JS `4719403c55b6061b7ff3ba260ae45783c4db846cb70ccd70ac51d5b03d87373d`. This test-only repair changes no browser production or historical receipt source labels.
