# Extension and source type scale (#5821)

`profiles-after.png` captures the Profiles dialog in Chrome at 1440×900, opened from the status bar after loading `/samples/building-architecture.ifc`. The IFC header identifies SketchUp 2024 with IFC-manager for SketchUp 5.3.3, and the loaded viewer reports 444 entities and 12 geometry elements. The Default profile row, status chips and action controls remain readable and fit within the dialog after adopting the shared `text-xs` scale. The browser used the SwiftShader WebGPU flags from `viewer-e2e-ci`.

Other extension/source/tour controls in this slice use the same token; the mounted BundlePreview test verifies native file-button selection and preview switching.
