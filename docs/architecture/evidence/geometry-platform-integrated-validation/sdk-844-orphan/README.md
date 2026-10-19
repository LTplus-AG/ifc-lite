<!-- SPDX-License-Identifier: MPL-2.0 -->
# Interrupted queued SDK request

Original request `auto-78be6c8f65c14c6fa827b54c54f7a2fb`, job
`9a733441-6688-4c33-ba4a-abe97a0b5c45`, source `8441381f544f9877450537609377f93b857c6548`.
The worker records this request as orphaned: no start time, runner hash or
command output was published. Its original receipt is preserved unchanged.
There is no build, test, runtime or numerical verdict for this request.

A later source checkpoint with the same repaired numerical code and additional
integration records was submitted as a distinct normal fleet request:
`auto-895582117bbf44bfbbc9bc38550d22ae`, source `80a8cc307a8a0ae055a8606197e66f4469e7a136`,
job `d9732438-f7d2-477f-98d7-bf893a697174`. Its detached launcher survives chat
interruptions and uses the existing storage cohort. At this observation it remains
queued, with its original launcher alive. No capacity override or duplicate
submission was used. These records do not rewrite either request's outcome.
