# spacemouse-driver (viewer module)

Opt-in SpaceMouse support for the IFC-Lite viewer, through the **3Dconnexion driver** (3DxWare) and the official
[`@3dconnexion/3dconnexionjs`](https://www.npmjs.com/package/@3dconnexion/3dconnexionjs) package (#9131).

It lives in the viewer app on purpose (`apps/viewer/src/lib/spacemouse-driver/`, not published): nothing in the published
`@ifc-lite/*` packages depends on it, so nobody building on those packages inherits the 3Dconnexion SDK licence. The SDK is
loaded lazily, only when the viewer calls `connect()`, which it does only while **Use the 3Dconnexion driver** is on.

## When to use it

| | WebHID path (default) | This module (driver path) |
|---|---|---|
| Needs the 3DxWare driver | no (must be **quit**: it can hold the device exclusively) | yes, running |
| Browsers | Chromium only | any browser that can reach the driver's local service |
| User gesture | required (permission prompt) | not needed, connects silently |
| Speed, axes, navigation mode | the app's own settings | the user's 3Dconnexion settings |

Keep WebHID as the default and the fallback. Offer this one as an opt-in ("Use the 3Dconnexion driver").

## Dependency

`@3dconnexion/3dconnexionjs` is a dependency of `apps/viewer` only (`apps/viewer/package.json`). It is never copied into
the repository. Read the [licensing section](#licensing-and-attribution) before shipping it.

## Where the viewer wires it

- `components/viewer/spaceMouseDriverCamera.ts`: the `DriverCamera` adapter over the renderer's camera.
- `components/viewer/useSpaceMouseControls.ts`: while the setting is on, lazily imports this module, connects, maps the
  Fit key to the viewer's fit, and disconnects when the setting is turned off. If `connect()` resolves `false`, WebHID
  stays in use.
- `components/viewer/SpaceMousePanel.tsx`: the setting and its status (Settings → Display → SpaceMouse).
- `components/viewer/KeyboardShortcutsDialogTabs.tsx`: the About tab shows `THREEDCONNEXION_ATTRIBUTION`.

## Usage

Implement `DriverCamera` as a thin adapter over your camera, then connect:

```ts
import type { DriverCamera } from '@/lib/spacemouse-driver';

// Loaded lazily, after the user turns the setting on: without it nothing from the 3Dconnexion SDK is fetched or run.
async function enableDriver(viewer: Viewer, canvas: HTMLCanvasElement) {
  const { SpaceMouseDriver } = await import('@/lib/spacemouse-driver');

  const cam = () => viewer.renderer.getCamera();
  const v = (p: { x: number; y: number; z: number }): [number, number, number] => [p.x, p.y, p.z];

  const adapter: DriverCamera = {
    canvas,
    getPose: () => ({ pos: v(cam().getPosition()), target: v(cam().getTarget()), up: v(cam().getUp()) }),
    setPose: (pos, target, up) => {
      // Keep the horizon level, as mouse orbit does; only looking straight up or down uses the driver's up vector.
      const fy = target[1] - pos[1];
      const flen = Math.hypot(target[0] - pos[0], fy, target[2] - pos[2]) || 1;
      const u: [number, number, number] = Math.abs(fy / flen) > 0.999 ? up : [0, 1, 0];
      const c = cam();
      c.stopInertia();
      c.setPosition(pos[0], pos[1], pos[2]);
      c.setTarget(target[0], target[1], target[2]);
      c.setUp(u[0], u[1], u[2]);
    },
    getFov: () => cam().getFOV(),
    setFov: (rad) => cam().setFOV(rad),
    getAspect: () => canvas.clientWidth / Math.max(1, canvas.clientHeight),
    getBounds: () => {
      const b = viewer.sceneBounds(); // { min: {x,y,z}, max: {x,y,z} } | null
      return b ? { min: v(b.min), max: v(b.max) } : null;
    },
    requestRender: () => viewer.renderer.requestRender(),
  };

  const driver = new SpaceMouseDriver(adapter, { appName: 'My viewer' });
  driver.onFit = () => viewer.fit();
  driver.onStatus = () => updateIndicator(driver.connected);
  const ok = await driver.connect(); // resolves false, silently, if the driver is not running
  if (!ok) fallBackToWebHid(driver.lastError);
  return driver; // driver.disconnect() when the user turns the setting off
}
```

World space is the renderer's frame: Y up, the camera looks down -Z, one unit is one metre.

### What `connect()` does

- Loads the SDK with a dynamic `import()`. If that fails, it resolves `false` and sets `lastError`.
- Connects to the driver's local web service. Resolves `true` when the device is attached to your canvas, `false` after
  `timeoutMs` (default 3000) if the driver does not answer. It never throws and logs nothing unless `debug: true`.
- A driver that starts *after* the timeout is still picked up: `onStatus` fires and `connected` becomes `true`.
- The canvas is made focusable and focused on pointer-down: the driver moves the focused view.
- Safe to call more than once. `disconnect()` releases the device, closes the session, removes the listeners, and allows a new `connect()`.

## Licensing and attribution

`@3dconnexion/3dconnexionjs` is **not open source**. It is under the
[3Dconnexion Software Development Kit licence](http://www.3dconnexion.com/service/software-developer/licence-agreement.html)
(also shipped as `LicenseAgreementSDK.txt` in the npm package). Points that matter here:

- **Attribution (section 2).** The host application must show this line in its About / Info box or its Help file,
  verbatim and in English, whenever the integration is present:

  > 3D input device development tools and related technology are provided under license from 3Dconnexion. © 3Dconnexion 1992 - 2025. All rights reserved.

  The module exports it as `THREEDCONNEXION_ATTRIBUTION` (and the licence link as `THREEDCONNEXION_LICENCE_URL`).
- **Distribution.** For JavaScript components the licence permits distribution solely as part of web applications designed
  to operate exclusively in conjunction with 3Dconnexion products.
- **Confidentiality / restrictions.** The licence treats the SDK source as confidential and forbids using it to build a
  product that competes with 3Dconnexion's.
- **Never vendor it.** Do not copy the SDK's files into a repository. It is installed from npm as a dependency of the
  viewer app only.

This is not legal advice. The code of *this* module (not the SDK) is under MPL-2.0.

## How it works

The driver's navigation library does the motion maths. It asks the application for the camera (view matrix, frustum, field
of view, model extents, pivot...) and writes the next pose back through `setViewMatrix`. `createNavigationModel()` is the
object it calls into; `poseToMatrix()` / `matrixToPose()` convert between your camera's position / target / up and the
library's 16-element column-major camera-to-world matrix. Value formats follow the 3DconnexionJS API reference: frustum
`[left, right, bottom, top, near, far]`, extents `[minX, minY, minZ, maxX, maxY, maxZ]`.

## Tested

- **Unit tests** (31 tests, `node:test`, run with the viewer's tests): the pose/matrix maths, every navigation-model callback against a mock
  camera, and the whole connect / timeout / late-connect / refusal / disconnect / lazy-load flow against a fake SDK. No hardware needed.
- **Real device:** macOS, Chrome, one SpaceMouse Compact, with the 3DxWare driver running. Not tested on Windows, Linux,
  other browsers or other 3Dconnexion devices.

## Limitations

- No hit-testing (`getLookAt` returns `null`): the driver falls back to the model extents and the camera target.
- No selection-based pivot or zoom to selection.
- Perspective projection only.
- Requires 3DxWare 10 (macOS 10.6.1 or newer; Windows 10.8.12 or newer), per the SDK's README.
- Cannot run as a sandboxed `.iflx` viewer extension: the SDK needs `window` and a network connection to the local driver.

## Debugging

Pass `debug: true` to log the connection and every property the driver requests:

```ts
new SpaceMouseDriver(adapter, { appName: 'My viewer', debug: true });
```

If `connect()` resolves `false` with "driver not reachable", check that 3DxWare is running and that its version meets the
requirement above.

## Development

From the repository root:

```sh
pnpm typecheck                                            # covers this module and its tests
TEST_PATTERN=spacemouse-driver pnpm --filter @ifc-lite/viewer test   # just these tests
```
