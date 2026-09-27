# Clash row selection (#5828)

`clearance-pair-inspector.png` is a Chromium/WebGPU capture from the built viewer on this branch. It loads the authored `apps/viewer/public/samples/building-architecture.ifc`, runs Clash detection in Clearance mode at 0.5 m, and clicks the first `IfcWall × IfcSlab` result. Information is opened below Clash through the viewer's split panel.

The selected wall (`expressId` 315) appears in Information, both selected IDs (315 and 395) remain in the store, and the viewport retains the amber/cyan pair colours. The run reported 18 real clearance results; this selected touching pair did not produce an intersection solid, so the pair colours remain visible. `cameraCallbacks.frameSelection` frames both selected elements after the click. The privacy notice was dismissed with its close button before capture.

The mounted teardown tests cover the split remount, secondary Clash moving to a float, and a real close clearing selection and paint. Single-model and federation-offset tests cover the model-aware and global-ID selection channels.
