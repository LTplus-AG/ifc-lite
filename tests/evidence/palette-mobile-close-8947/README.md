# Mobile search close observation (#8947)

This uses the repository revert oracle’s supported surgical mutation discovery
(#7955). Reverse-applying the patch disconnects the real mobile close button
without removing the component, imports, store, or test assertions. The existing
mounted test clicks that button and requires the search field to become hidden;
it also checks exit from a real result cycle and reopening the same field.

The oracle requires a green attributable baseline and an actual assertion
failure under the mutation. This supplies one observation witness, as required
by the gate; it does not claim full feature or browser coverage. The ordinary
CI and merge-queue suites remain unchanged.

The combined PR’s default whole-production revert job exceeded its 45-minute
limit. Its cancelled logs were unavailable, so the exact stalled test or stage
is unknown. This witness avoids deleting new modules and relying on a costly
browser fallback; no timeout, exemption, workflow, or acceptance rule changes.
