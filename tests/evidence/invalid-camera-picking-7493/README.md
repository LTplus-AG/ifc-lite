# Invalid camera picking (#7493)

The production report contains four unhandled point-selection exceptions after an RTE camera frame became unavailable. This change prevents selection from consuming that unavailable frame; it does not establish what moved the original 615.95 MB production model session beyond the supported envelope.

The regression suite uses the real Camera and PickingManager, with deferred GPU boundaries. Before the change, three invalid-camera admission cases throw and one pending CPU rectangle incorrectly returns old hits. After the change, all 88 focused camera/picking tests pass. The tests also prove picking resumes after a supported pose is restored.

Native viewer qualification used the catalogued Archicad FZK fixture on NVIDIA Blackwell WebGPU. With a valid pose, the real GPU pick returned entity 59753 / geometry item 59737. Setting camera X to 1,000,000,001 deliberately invalidated the frame: point picking returned null, rectangle picking returned an empty set, and a real canvas click produced no unhandled rejection. Restoring the original pose returned exactly the same entity, item, and world coordinates, and rendering resumed with 52 draw calls. See `receipt.json` and `recovered.png`.

This is functional qualification, not a performance measurement or a reproduction of the original model's camera trigger. The issue stays open for that trigger and recovery investigation.
