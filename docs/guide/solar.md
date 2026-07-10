# Solar Analysis

IFClite includes pure, dependency-free solar math for BIM sun studies. The `@ifc-lite/solar` package computes solar position, sunrise and sunset times, and 3D sun-path geometry (day arcs, hourly analemmas, and a dome graticule) from just a date and a site latitude/longitude.

Accuracy is about 0.01 degrees for the years 1900 to 2100, using the NOAA algorithms (truncated Meeus/VSOP).

## Conventions

- **Azimuth** - degrees clockwise from true north, 0 to 360
- **Altitude** - degrees above the horizon (negative when the sun is below it)
- **Dates** - a `Date` is treated as an absolute UTC instant; latitude is north-positive, longitude east-positive, both plain numbers (there is no location object type)
- **Geometry** - all path generators return unit direction vectors in ENU (east, north, up) as `{ e, n, u }`; a renderer scales them by a dome radius and adds the site origin

## Quick Start

### Sun Position

```typescript
import { sunPosition } from '@ifc-lite/solar';

// sunPosition(date: Date, latitude: number, longitude: number): SunPosition
const pos = sunPosition(new Date('2024-06-21T12:00:00Z'), 51.4769, -0.0005);

pos.azimuth;        // degrees clockwise from true north (0-360)
pos.altitude;       // degrees above the horizon
pos.declination;    // solar declination in degrees
pos.equationOfTime; // apparent minus mean solar time, in minutes
```

### Sunrise and Sunset

```typescript
import { sunTimes } from '@ifc-lite/solar';

// sunTimes(date: Date, latitude: number, longitude: number): SunTimes
const times = sunTimes(new Date('2024-06-21T12:00:00Z'), 51.4769, -0.0005);

times.sunrise;    // Date | null (null during polar night)
times.sunset;     // Date | null (null during midnight sun)
times.solarNoon;  // Date, always defined
times.alwaysUp;   // true if the sun never sets that UTC day
times.alwaysDown; // true if it never rises
```

Times are computed for the UTC calendar day containing `date`, with the standard refraction-corrected zenith of 90.833 degrees.

## Worked Example: Sun Position and Sun-Path Geometry

```typescript
import {
  sunPosition,
  dayPath,
  analemmaPaths,
  domeGraticule,
  azimuthAltitudeToEnu,
} from '@ifc-lite/solar';

const lat = 51.4769;   // degrees north
const lon = -0.0005;   // degrees east
const date = new Date('2024-06-21T12:00:00Z');

// 1. Where is the sun right now?
const { azimuth, altitude } = sunPosition(date, lat, lon);

// 2. Turn the angles into a renderable direction
const dir = azimuthAltitudeToEnu(azimuth, altitude); // { e, n, u } unit vector
// worldPos = siteOrigin + dir * domeRadius

// 3. The day arc: an ordered morning-to-evening polyline of SunSample
const arc = dayPath(date, lat, lon, {
  stepMinutes: 10,       // default 10
  aboveHorizonOnly: true // default true: drop below-horizon samples
});
// each sample: { time, azimuth, altitude, dir: { e, n, u }, aboveHorizon, ... }

// 4. Hourly analemmas for a whole year (note: first argument is a YEAR, not a Date)
const analemmas = analemmaPaths(2024, lat, lon, { dayStep: 5 });
// one AnalemmaPath { hour, samples } per clock hour with above-horizon samples

// 5. A static dome reference grid (site and date independent)
const grid = domeGraticule({ altitudeStep: 15, azimuthStep: 30, resolution: 5 });
// grid.altitudeRings: { altitude, ring: Enu[] }[]
// grid.azimuthSpokes: { azimuth, arc: Enu[] }[]
// grid.cardinals:     { label, dir: Enu }[]  (N, NE, E, ...)
```

All geometry functions return plain data (ENU unit vectors), not renderer buffers, so the package works with any 3D engine.

## API Summary

| Export | Description |
|--------|-------------|
| `sunPosition(date, latitude, longitude)` | Azimuth, altitude, declination, equation of time |
| `sunPositionFromGeometry(date, lat, lon, declination, equationOfTime)` | Fast variant for per-day loops that already computed geometry |
| `solarGeometry(date)` | Date-only declination and equation of time |
| `toJulianDay(date)` | Julian day number |
| `sunTimes(date, latitude, longitude)` | Sunrise, sunset, solar noon, polar flags |
| `azimuthAltitudeToEnu(azimuthDeg, altitudeDeg)` | Angles to ENU unit vector |
| `dayPath(date, latitude, longitude, options?)` | Sun arc for one day as `SunSample[]` |
| `analemmaPaths(year, latitude, longitude, options?)` | Hourly figure-eight paths for a year |
| `domeGraticule(options?)` | Altitude rings, azimuth spokes, compass cardinals |

Key types: `SunPosition`, `SunTimes`, `Enu`, `SunSample`, `DayPathOptions`, `AnalemmaPath`, `AnalemmaOptions`, `Graticule`, `GraticuleOptions`.

## Viewer Integration

The IFClite viewer builds a full solar study on top of this package:

- **Sun & Sky panel** - Pick a date and time; the viewer computes the sun with `sunPosition` and `sunTimes` for the model's georeferenced site
- **Sun-path dome** - A "Dome" toggle overlays the day arc, hourly analemmas, graticule, compass cardinals, and a live sun marker on the model (in the Cesium map view the ENU vectors are pinned to the site through an east-north-up frame at the model origin)
- **Shadow study** - The computed sun direction drives scene lighting and shadows for a studied instant

The site location comes from the model's georeferencing, so a correctly georeferenced IFC gets a physically accurate sun with no extra setup.

See the [package README](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/solar) for the full API reference.
