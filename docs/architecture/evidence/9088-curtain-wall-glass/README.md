# Curtain wall panels are glass (#9088)

Captured on 6 November 2026 from a production viewer build of this change, in Windows Chrome 156 on an NVIDIA Blackwell adapter, driven with real pointer and keyboard input.

- [Live, straight after placing](live-after-placing.jpg): the Model workspace, no reload. Before this change the same panels rendered opaque until the model was exported and reopened.
- [The exported IFC, reopened in a fresh page](reopened-export.jpg): the same glass, from the file.

The export, read with IfcOpenShell 0.8.5: schema IFC4X3, 78 `IfcPlate` panels, 78 `IfcStyledItem`, one `Curtain wall glazing` style per curtain wall, shading transparency 0.72.
