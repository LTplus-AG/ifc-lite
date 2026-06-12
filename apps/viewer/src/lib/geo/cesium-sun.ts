/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Cesium sun helpers — turn the renderer-agnostic geometry from
 * `@ifc-lite/solar` into real Cesium scene state for a georeferenced sun-path
 * + shadow study:
 *
 *   • applySolarScene  — drive Cesium's sun, lighting and shadow map from a
 *                        chosen instant (the model + OSM context then cast and
 *                        receive real shadows).
 *   • SunPathDome      — a self-contained set of polyline/point entities for
 *                        the 3D dome (day arc, hourly analemmas, graticule,
 *                        cardinals, and the live sun marker + beam).
 *
 * All dome geometry is positioned by mapping the solar package's ENU unit
 * vectors through `eastNorthUpToFixedFrame(origin)`, the same ENU→ECEF frame
 * the coordinate bridge uses, so the dome is pinned to the model's true site.
 */

import {
  analemmaPaths,
  dayPath,
  domeGraticule,
  azimuthAltitudeToEnu,
  sunPosition,
  type Enu,
} from '@ifc-lite/solar';

type CesiumNs = typeof import('cesium');
type CesiumViewer = InstanceType<typeof import('cesium').Viewer>;

export interface SolarSceneOptions {
  /** Studied instant. */
  date: Date;
  /** Master enable — false restores the neutral (no-sun) overlay state. */
  enabled: boolean;
  /** Whether to render the shadow map (mutual model ↔ context shadows). */
  shadows: boolean;
  /**
   * Show the sun billboard. Off by default (transparent compositing); the
   * environment panel's Sky toggle turns it on together with the atmosphere.
   */
  showSun?: boolean;
}

/**
 * Drive Cesium's sun, lighting and shadow map from the studied instant.
 * Idempotent — safe to call every time the date or toggles change.
 */
export function applySolarScene(
  Cesium: CesiumNs,
  viewer: CesiumViewer,
  options: SolarSceneOptions,
): void {
  const scene = viewer.scene;
  const { enabled, shadows, date, showSun = false } = options;

  if (!enabled) {
    // Restore the transparent-compositing defaults set up in CesiumOverlay
    // (the sun billboard stays available for the Sky toggle).
    if (scene.sun) scene.sun.show = showSun;
    scene.globe.enableLighting = false;
    viewer.shadows = false;
    scene.light = new Cesium.DirectionalLight({
      direction: new Cesium.Cartesian3(0.5, -1.0, -0.3),
    });
    return;
  }

  // Pin the simulation clock to the studied instant so Cesium's SunLight and
  // shadow map are computed for exactly this date/time.
  const julian = Cesium.JulianDate.fromDate(date);
  viewer.clock.shouldAnimate = false;
  viewer.clock.currentTime = julian;
  scene.light = new Cesium.SunLight();
  if (scene.sun) scene.sun.show = showSun; // billboard only with the Sky toggle
  scene.globe.enableLighting = true;
  viewer.shadows = shadows;
  if (viewer.shadowMap) {
    viewer.shadowMap.enabled = shadows;
    viewer.shadowMap.softShadows = true;
    viewer.shadowMap.darkness = 0.35;
  }
  scene.requestRender();
}

export interface SunPathDomeOptions {
  /** Site origin (model georef). */
  origin: { longitude: number; latitude: number; height: number };
  /** Dome radius in metres. */
  radius: number;
  /** Studied instant (positions the live sun marker). */
  date: Date;
  /** Show the hourly analemma figure-eights. */
  showAnalemmas?: boolean;
}

const DAY_ARC_COLOR = [255, 200, 40] as const; // warm yellow
const ANALEMMA_COLOR = [120, 170, 255] as const; // cool blue
const GRID_COLOR = [255, 255, 255] as const;
const SUN_COLOR = [255, 230, 120] as const;

/**
 * A self-contained collection of Cesium entities forming the 3D sun-path
 * dome. Construct once for a site/date, then call {@link update} as the
 * studied instant changes (only the sun marker + beam move), and
 * {@link destroy} to remove every entity.
 */
export class SunPathDome {
  private readonly Cesium: CesiumNs;
  private readonly viewer: CesiumViewer;
  private readonly dataSource: InstanceType<typeof import('cesium').CustomDataSource>;
  private readonly options: SunPathDomeOptions;
  private readonly enuToEcef: InstanceType<typeof import('cesium').Matrix4>;
  private sunMarker: InstanceType<typeof import('cesium').Entity> | null = null;
  private sunBeam: InstanceType<typeof import('cesium').Entity> | null = null;

  /** Build the dome's data source + static geometry and add it to the viewer. */
  constructor(Cesium: CesiumNs, viewer: CesiumViewer, options: SunPathDomeOptions) {
    this.Cesium = Cesium;
    this.viewer = viewer;
    this.options = options;
    this.dataSource = new Cesium.CustomDataSource('ifc-lite-sun-path');

    const originCart = Cesium.Cartesian3.fromDegrees(
      options.origin.longitude,
      options.origin.latitude,
      options.origin.height,
    );
    this.enuToEcef = Cesium.Transforms.eastNorthUpToFixedFrame(originCart);

    this.buildStatic();
    this.update(options.date);
    // Await attach, THEN request a render: the viewer runs in requestRenderMode,
    // so a render requested before the data source is attached would paint
    // nothing and the dome would stay invisible until the next camera move.
    viewer.dataSources
      .add(this.dataSource)
      .then(() => {
        viewer.scene.requestRender();
        console.log('[SunPathDome] built', {
          lat: options.origin.latitude,
          lon: options.origin.longitude,
          height: options.origin.height,
          radius: options.radius,
          entities: this.dataSource.entities.values.length,
        });
      })
      .catch((err) => console.warn('[SunPathDome] failed to add data source:', err));
  }

  /** Map a single ENU direction (unit) at the dome radius to an ECEF position. */
  private enuDirToEcef(dir: Enu, radiusScale = 1): InstanceType<typeof import('cesium').Cartesian3> {
    const r = this.options.radius * radiusScale;
    return this.Cesium.Matrix4.multiplyByPoint(
      this.enuToEcef,
      new this.Cesium.Cartesian3(dir.e * r, dir.n * r, dir.u * r),
      new this.Cesium.Cartesian3(),
    );
  }

  /** Add a polyline entity from a list of ENU directions at the dome radius. */
  private polyline(
    dirs: Enu[],
    rgb: readonly [number, number, number],
    width: number,
  ): void {
    if (dirs.length < 2) return;
    const positions = dirs.map((d) => this.enuDirToEcef(d));
    this.dataSource.entities.add({
      polyline: {
        positions,
        width,
        material: this.Cesium.Color.fromBytes(rgb[0], rgb[1], rgb[2], 235),
        // Draw the dome even where it sits behind terrain / 3D tiles or the
        // model, dimmer, so the full sun path stays legible in 3D.
        depthFailMaterial: this.Cesium.Color.fromBytes(rgb[0], rgb[1], rgb[2], 90),
        arcType: this.Cesium.ArcType.NONE,
      },
    });
  }

  /** Build the date-independent geometry: graticule, cardinals, analemmas, day arc. */
  private buildStatic(): void {
    const { origin, date } = this.options;

    // Graticule — altitude rings + azimuth spokes.
    const grat = domeGraticule({ altitudeStep: 15, azimuthStep: 30 });
    for (const ring of grat.altitudeRings) {
      this.polyline(ring.ring, GRID_COLOR, ring.altitude === 0 ? 2 : 1);
    }
    for (const spoke of grat.azimuthSpokes) {
      this.polyline(spoke.arc, GRID_COLOR, 1);
    }

    // Cardinal / ordinal labels on the horizon.
    for (const c of grat.cardinals) {
      this.dataSource.entities.add({
        position: this.enuDirToEcef(c.dir, 1.05),
        label: {
          text: c.label,
          font: '600 14px sans-serif',
          fillColor: this.Cesium.Color.WHITE,
          outlineColor: this.Cesium.Color.BLACK,
          outlineWidth: 2,
          style: this.Cesium.LabelStyle.FILL_AND_OUTLINE,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
    }

    // Hourly analemmas (figure-eights) across the year.
    if (this.options.showAnalemmas ?? true) {
      const year = date.getUTCFullYear();
      for (const path of analemmaPaths(year, origin.latitude, origin.longitude, { dayStep: 5 })) {
        const above = path.samples.filter((s) => s.aboveHorizon).map((s) => s.dir);
        this.polyline(above, ANALEMMA_COLOR, 1);
      }
    }

    // Day arc for the studied date.
    const arc = dayPath(date, origin.latitude, origin.longitude, { stepMinutes: 10 });
    this.polyline(arc.map((s) => s.dir), DAY_ARC_COLOR, 2);
  }

  /** Reposition the live sun marker + beam for a new instant. */
  update(date: Date): void {
    const { origin } = this.options;
    const pos = sunPosition(date, origin.latitude, origin.longitude);
    const dir = azimuthAltitudeToEnu(pos.azimuth, pos.altitude);
    const show = pos.altitude >= 0;
    const sunEcef = this.enuDirToEcef(dir);
    const originEcef = this.enuDirToEcef({ e: 0, n: 0, u: 0 });

    if (!this.sunMarker) {
      this.sunMarker = this.dataSource.entities.add({
        position: sunEcef,
        point: {
          pixelSize: 16,
          color: this.Cesium.Color.fromBytes(SUN_COLOR[0], SUN_COLOR[1], SUN_COLOR[2], 255),
          outlineColor: this.Cesium.Color.fromBytes(255, 140, 0, 255),
          outlineWidth: 3,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      this.sunBeam = this.dataSource.entities.add({
        polyline: {
          positions: [originEcef, sunEcef],
          width: 2,
          material: this.Cesium.Color.fromBytes(SUN_COLOR[0], SUN_COLOR[1], SUN_COLOR[2], 160),
          depthFailMaterial: this.Cesium.Color.fromBytes(SUN_COLOR[0], SUN_COLOR[1], SUN_COLOR[2], 70),
          arcType: this.Cesium.ArcType.NONE,
        },
      });
    } else {
      this.sunMarker.position = new this.Cesium.ConstantPositionProperty(sunEcef);
      if (this.sunBeam?.polyline) {
        this.sunBeam.polyline.positions = new this.Cesium.ConstantProperty([originEcef, sunEcef]);
      }
    }
    if (this.sunMarker.point) {
      this.sunMarker.point.show = new this.Cesium.ConstantProperty(show);
    }
    if (this.sunBeam?.polyline) {
      this.sunBeam.polyline.show = new this.Cesium.ConstantProperty(show);
    }
    this.viewer.scene.requestRender();
  }

  /** Remove every dome entity and detach the data source from the viewer. */
  destroy(): void {
    this.dataSource.entities.removeAll();
    void this.viewer.dataSources.remove(this.dataSource, true);
  }
}
