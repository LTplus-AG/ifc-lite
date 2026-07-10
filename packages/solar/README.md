# @ifc-lite/solar

Solar position, sunrise/sunset and 3D sun-path geometry for IFC-Lite.

Pure, dependency-free math. Given a site latitude/longitude and an instant it
computes where the sun is, and generates the sampled curves that make up a 3D
**sun-path dome** — the day arc, the hourly analemmas, and the static
graticule (altitude rings, azimuth spokes, compass labels).

Outputs are renderer-agnostic: plain angles plus **ENU unit vectors**
(east / north / up), matching the IFC + Cesium georeferencing convention used
by the viewer, so a renderer only multiplies by a dome radius and adds the
site origin.

## Installation

```bash
npm install @ifc-lite/solar
```

## Usage

```ts
import { sunPosition, sunTimes, dayPath, analemmaPaths, domeGraticule } from '@ifc-lite/solar';

// Where is the sun right now at this site?
const { azimuth, altitude } = sunPosition(new Date(), 51.4769, -0.0005);

// Sunrise / sunset / solar noon for the day.
const { sunrise, sunset, solarNoon } = sunTimes(new Date(), 51.4769, -0.0005);

// Geometry for a 3D dome.
const arc        = dayPath(new Date(), 51.4769, -0.0005);   // today's path
const analemmas  = analemmaPaths(2024, 51.4769, -0.0005);   // hourly figure-eights
const graticule  = domeGraticule();                          // rings + spokes + N/E/S/W
```

## Accuracy

Uses the NOAA Solar Calculation algorithm (a truncated Meeus/VSOP model),
accurate to within ~0.01° of azimuth/altitude for 1900–2100 — well beyond what
architectural shadow / right-to-light studies require.

## Conventions

- **Azimuth**: degrees clockwise from true north (N = 0°, E = 90°, S = 180°, W = 270°).
- **Altitude**: degrees above the horizon (negative below).
- **Time**: a JavaScript `Date`, interpreted as the absolute UTC instant
  (`getTime()`), so callers never reason about the host timezone.

## Docs

See the [ifc-lite docs](https://ifclite.dev/docs/) and the
[API Reference](https://ifclite.dev/docs/api/typescript/).

## License

MPL-2.0
