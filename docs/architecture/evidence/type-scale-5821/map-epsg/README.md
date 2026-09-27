# Map and EPSG type scale (#5821)

`after.png` is a 1440×900 Chrome capture of this branch at `?model=/samples/building-architecture.ifc`, after scrolling the Properties pane to Location. The repository sample's IFC header identifies SketchUp 2024 and IFC-manager for SketchUp 5.3.3; the browser loaded 444 entities and 12 geometry elements. The Projected CRS, coordinate operation and location map remain readable in the 320 px pane, including the map's external links. Chrome ran headless with SwiftShader WebGPU flags matching `viewer-e2e-ci`.

The work here changes the map and EPSG dialog's 9–11 px copy to the shared `text-xs` scale. MapLibre's own attribution remains at its upstream 7 px style, outside our UI text scale.
