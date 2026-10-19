<!-- SPDX-License-Identifier: MPL-2.0 -->
# Corrected workspace request orphaned before admission

Request auto-5794785ee2ed4fce822a6b02f55dea20, job
3361d04d-7fdb-4405-96fb-c32eaf56ae4f, source9460a3de7b, is authoritatively orphaned:
the wrapper exited and no live child group remains. The receipt has no startedAt,
exitCode or sourceUnchanged result, and no output.log exists. No test or Clippy
result is claimed. The original unknown outcome is preserved without replay.
Later corrected-source qualification must remain distinct from this attempt.
