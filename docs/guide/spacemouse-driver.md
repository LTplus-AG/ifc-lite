# SpaceMouse through the 3Dconnexion driver (optional)

The viewer supports 3Dconnexion SpaceMouse devices over WebHID by default (Chromium browsers; the 3DxWare driver must be
quit, because it can hold the device exclusively).

If you want to keep the driver running, enable **Use the 3Dconnexion driver** in the viewer settings (Settings → Display →
SpaceMouse). The viewer then loads its driver module on demand and connects to the driver's local service. Speed, axes and
navigation mode come from your 3Dconnexion settings. If the driver is not running, nothing happens and WebHID stays in use.

**Requirements:** 3DxWare 10 running (macOS 10.6.1+ / Windows 10.8.12+).

**Tested:** macOS, Chrome, SpaceMouse Compact. Windows, Linux, other browsers and other devices are untested.

**Limits:** no hit-testing, no selection-based pivot, perspective projection only.

**Licence:** this path uses the 3Dconnexion SDK (`@3dconnexion/3dconnexionjs`), which is under the
[3Dconnexion SDK licence](http://www.3dconnexion.com/service/software-developer/licence-agreement.html), not an open-source
licence. It is a dependency of the viewer app only (none of the published `@ifc-lite/*` packages depend on it), and it is
never loaded unless you turn the setting on. The viewer's About page shows:

> 3D input device development tools and related technology are provided under license from 3Dconnexion. © 3Dconnexion 1992 - 2025. All rights reserved.
