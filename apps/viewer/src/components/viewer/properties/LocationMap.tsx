/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LocationMap — a compact MapLibre GL JS minimap that shows the model's
 * real-world position derived from IfcMapConversion + IfcProjectedCRS.
 *
 * Features:
 *   - Place/drag pin on map to reposition the model
 *   - Search for places via Nominatim geocoding
 *   - Query terrain elevation at pin location
 *   - Apply pin position back to IfcMapConversion (eastings/northings/height)
 *   - Links to Google Maps, OpenStreetMap, and Google Earth (KMZ export)
 */

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import {
  Map as MapIcon, ExternalLink, Loader2, MapPinOff, Globe2,
  Search, Mountain, MapPin, X, Check,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';
import { downloadBlob } from '@/lib/export/download';
import { reprojectToLatLon, reprojectFromLatLon, queryTerrainElevation, computeFootprintGeoJSON, type LatLon } from '@/lib/geo/reproject';
import { buildKmzForResolvedGeoref } from '@/lib/geo/kmz-export';
import type { KmzProcessor } from '@/lib/geo/kmz-exporter';
import {
  probeMapWebglSupport, markMapWebglUnsupported, takeMapWebglReportSlot,
  getMapWebglVerdict, describeMapInitFailure, watchContextCreationStatus,
  reconstructMapInitFailure, type MapWebglFailureReason,
} from '@/lib/geo/map-webgl-support';
import { posthog } from '@/lib/analytics';
import { addFootprintToMap, removeFootprintFromMap } from './location-map-footprint';
import { geocodeSearch, type GeocodeResult } from './location-map-geocode';
import { loadMaplibre, disposeMap, purgeMapContainer } from './location-map-lifecycle';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';

/** Position picked on the map, ready to be applied to IfcMapConversion */
export interface PickedPosition {
  easting: number;
  northing: number;
  terrainHeight: number | null;
}

export interface LocationMapProps {
  mapConversion?: MapConversion;
  projectedCRS?: ProjectedCRS;
  /** Coordinate info from the model's GeometryResult (includes bounds and RTC offset) */
  coordinateInfo?: CoordinateInfo;
  /** Geometry result for KMZ export (optional — KMZ button hidden if not provided) */
  geometryResult?: GeometryResult | null;
  /** IFC project length unit → metres (e.g. 0.001 for mm models). Default 1 (metres). */
  lengthUnitScale?: number;
  /** Whether the map is in edit mode (allows repositioning) */
  editable?: boolean;
  /** Called when the user applies a new position from the map */
  onApplyPosition?: (position: PickedPosition) => void;
  /**
   * wasm seam for the KMZ export, forwarded to `buildKmzForResolvedGeoref`.
   * Production leaves it undefined and gets the real `GeometryProcessor`;
   * `LocationMap.kmz.test.tsx` passes a stub so the Google Earth button can be
   * driven end to end under `tsx --test`, where the engine cannot load. Same
   * seam `buildKmz` has always exposed to `kmz-exporter.test.ts`, one level up
   * — without it this call site is untestable, which is exactly how it drifted
   * out of sync with the Export KMZ dialog (#2526 follow-up).
   */
  createKmzProcessor?: () => KmzProcessor;
}

type MapState = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Why the minimap could not be shown. Kept separate from `MapState`, which
 * tracks *coordinate resolution*: the two are independent, and folding them
 * together would let a later reprojection silently clear a device-level
 * failure and re-trigger the very construction that failed.
 *
 * `map_load_failed` is the one non-device reason — the maplibre chunk itself
 * failed to download — and it deliberately does NOT latch, because a chunk
 * fetch is transient in a way a missing GPU capability is not.
 */
type MapUnavailableReason = MapWebglFailureReason | 'map_load_failed';

export function LocationMap({
  mapConversion, projectedCRS, coordinateInfo, geometryResult,
  lengthUnitScale = 1, editable, onApplyPosition, createKmzProcessor,
}: LocationMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<InstanceType<typeof import('maplibre-gl').Map> | null>(null);
  const markerRef = useRef<InstanceType<typeof import('maplibre-gl').Marker> | null>(null);
  const pickedMarkerRef = useRef<InstanceType<typeof import('maplibre-gl').Marker> | null>(null);
  const editableRef = useRef(editable);

  // Keep editableRef in sync; clean up edit-only state when leaving edit mode
  useEffect(() => {
    editableRef.current = editable;
    if (!editable) {
      setSearchOpen(false);
      setSearchQuery('');
      setSearchResults([]);
      setSearchLoading(false);
      pickedMarkerRef.current?.remove();
      pickedMarkerRef.current = null;
      setPickedLatLon(null);
      setProjectedCoords(null);
      setPickedElevation(null);
      setElevationLoading(false);
    }
  }, [editable]);

  const [mapState, setMapState] = useState<MapState>('idle');
  const [latLon, setLatLon] = useState<LatLon | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seeded from the session latch, so a remount on a device already known to
  // refuse WebGL paints the fallback immediately — no probe, no construction,
  // no half-built canvas. This is what turns the accordion's collapse/expand
  // cycle from "throw again" into "already answered".
  const [mapUnavailable, setMapUnavailable] = useState<MapUnavailableReason | null>(() => {
    const verdict = getMapWebglVerdict();
    return verdict && !verdict.supported ? verdict.reason ?? 'probe_no_context' : null;
  });

  /**
   * Degrade to the no-map fallback and report once per session.
   *
   * `posthog.captureException` (rather than letting the throw escape) is the
   * point: an explicit capture is recorded as HANDLED, so an unsupported GPU
   * stops arriving as an error-level uncaught exception for something no user
   * and no code change can fix.
   *
   * Handled is not the same as low-severity, though, and posthog-js stamps
   * every capture `$exception_level: 'error'` regardless. Grouping and severity
   * are settled downstream in `lib/analytics-scrub.ts`, off the
   * `webgl_unavailable` kind `classifyLoadError` derives from the message: ONE
   * fingerprint for the whole family (the default hash includes the stack, so
   * this minted a new issue per deploy — #2354) and `error` rewritten to
   * `warning`. Nothing here needs to opt in; do not add a second reporting path
   * for it. `map_load_failed` is deliberately outside that family — a chunk
   * that would not download is ours to fix and stays loud.
   */
  const degradeMap = useCallback((reason: MapUnavailableReason, err: unknown) => {
    // A missing GPU capability is a property of the device, so latch it for the
    // session. A failed chunk download is not — leave that one retryable.
    if (reason !== 'map_load_failed') markMapWebglUnsupported(reason);
    setMapUnavailable(reason);
    if (!takeMapWebglReportSlot()) return;
    const detail = describeMapInitFailure(err);
    posthog.captureException(err, {
      context: 'location_map_webgl',
      map_unavailable_reason: reason,
      // `webgl_status`, not `..._message`: the analytics scrub deletes any key
      // containing the word `message` (free text is where model names leak).
      // This value is a driver capability string — it describes the GPU and
      // carries nothing about the model — so it is worth keeping intact.
      ...(detail.status ? { webgl_status: detail.status } : {}),
      ...(detail.eventType ? { webgl_event_type: detail.eventType } : {}),
    });
  }, []);

  // Picked position state (user-placed pin)
  const [pickedLatLon, setPickedLatLon] = useState<LatLon | null>(null);
  const [pickedElevation, setPickedElevation] = useState<number | null>(null);
  const [elevationLoading, setElevationLoading] = useState(false);
  const [projectedCoords, setProjectedCoords] = useState<{ easting: number; northing: number } | null>(null);

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const debouncedQuery = useDebouncedValue(searchQuery, 400);

  // Building footprint state (bounding box polygon in WGS84)
  const [footprint, setFootprint] = useState<[number, number][] | null>(null);
  const [styleVersion, setStyleVersion] = useState(0);
  const footprintRef = useRef<[number, number][] | null>(null);

  // Compute building footprint from bounding box
  useEffect(() => {
    if (!mapConversion || !projectedCRS || !coordinateInfo) {
      setFootprint(null);
      footprintRef.current = null;
      return;
    }

    let cancelled = false;

    computeFootprintGeoJSON(mapConversion, projectedCRS, coordinateInfo, lengthUnitScale).then(fp => {
      if (cancelled) return;
      setFootprint(fp);
      footprintRef.current = fp;
    });

    return () => { cancelled = true; };
  }, [mapConversion, projectedCRS, coordinateInfo, lengthUnitScale]);

  // Geocode search
  useEffect(() => {
    if (!debouncedQuery.trim()) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    setSearchLoading(true);
    geocodeSearch(debouncedQuery).then(results => {
      if (!cancelled) {
        setSearchResults(results);
        setSearchLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [debouncedQuery]);

  // Reproject model position to lat/lon
  useEffect(() => {
    if (!mapConversion || !projectedCRS) {
      setLatLon(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setMapState('loading');
    setError(null);

    reprojectToLatLon(mapConversion, projectedCRS, coordinateInfo, lengthUnitScale).then(result => {
      if (cancelled) return;
      if (result) {
        setLatLon(result);
        setMapState('ready');
      } else {
        setLatLon(null);
        setError('Could not resolve projection — EPSG code may be unsupported');
        setMapState('error');
      }
    });

    return () => { cancelled = true; };
  }, [mapConversion, projectedCRS, coordinateInfo, lengthUnitScale]);

  // When a picked position changes, reverse-project and query elevation
  useEffect(() => {
    if (!pickedLatLon || !projectedCRS) {
      setProjectedCoords(null);
      setPickedElevation(null);
      return;
    }

    let cancelled = false;
    setProjectedCoords(null);

    // Reverse-project to get IfcMapConversion eastings/northings
    // Accounts for model local geometry offset, rotation, and scale
    reprojectFromLatLon(pickedLatLon, projectedCRS, mapConversion, coordinateInfo, lengthUnitScale).then(coords => {
      if (!cancelled) setProjectedCoords(coords);
    });

    // Query terrain elevation
    setElevationLoading(true);
    queryTerrainElevation(pickedLatLon).then(elev => {
      if (!cancelled) {
        setPickedElevation(elev);
        setElevationLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [pickedLatLon, projectedCRS, mapConversion, coordinateInfo, lengthUnitScale]);

  // Place or move the picked marker on the map
  const updatePickedMarker = useCallback((pos: LatLon, maplibregl: typeof import('maplibre-gl')) => {
    if (!mapRef.current) return;
    if (pickedMarkerRef.current) {
      pickedMarkerRef.current.setLngLat([pos.lon, pos.lat]);
    } else {
      const el = document.createElement('div');
      el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="#7c3aed" stroke="white" stroke-width="2"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`;
      el.style.cursor = 'grab';
      const marker = new maplibregl.Marker({ element: el, draggable: true })
        .setLngLat([pos.lon, pos.lat])
        .addTo(mapRef.current);
      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        setPickedLatLon({ lat: lngLat.lat, lon: lngLat.lng });
      });
      pickedMarkerRef.current = marker;
    }
  }, []);

  // Handle map click to place pin (reads editable from ref to avoid stale closure)
  const handleMapClick = useCallback((e: { lngLat: { lat: number; lng: number } }) => {
    if (!editableRef.current) return;
    const pos = { lat: e.lngLat.lat, lon: e.lngLat.lng };
    setPickedLatLon(pos);
    // These two chains reach maplibre only to move a marker, so a failed chunk
    // is not worth degrading the panel for: the pin state above is already set
    // and the coordinate readout still updates. Without a handler the rejection
    // would surface as an uncaught error (see lib/chunk-version-skew.ts).
    loadMaplibre()
      .then(ml => updatePickedMarker(pos, ml))
      .catch(err => console.warn('[location-map] could not update the picked marker:', err));
  }, [updatePickedMarker]);

  // Handle search result selection
  const handleSearchSelect = useCallback((result: GeocodeResult) => {
    const pos = { lat: result.lat, lon: result.lon };
    setPickedLatLon(pos);
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);

    loadMaplibre()
      .then(ml => {
        updatePickedMarker(pos, ml);
        mapRef.current?.flyTo({ center: [pos.lon, pos.lat], zoom: 16, duration: 1200 });
      })
      .catch(err => console.warn('[location-map] could not move to the search result:', err));
  }, [updatePickedMarker]);

  // Handle apply position (waits for elevation to finish loading)
  const handleApply = useCallback(() => {
    if (!projectedCoords || !onApplyPosition || elevationLoading) return;
    onApplyPosition({
      easting: Math.round(projectedCoords.easting * 1000) / 1000,
      northing: Math.round(projectedCoords.northing * 1000) / 1000,
      terrainHeight: pickedElevation,
    });
    // Clear picked state after applying
    pickedMarkerRef.current?.remove();
    pickedMarkerRef.current = null;
    setPickedLatLon(null);
    setProjectedCoords(null);
    setPickedElevation(null);
  }, [projectedCoords, pickedElevation, onApplyPosition, elevationLoading]);

  // Clear picked pin
  const handleClearPick = useCallback(() => {
    pickedMarkerRef.current?.remove();
    pickedMarkerRef.current = null;
    setPickedLatLon(null);
    setProjectedCoords(null);
    setPickedElevation(null);
  }, []);

  // Initialize/update the map when we have a valid lat/lon
  useEffect(() => {
    if (!latLon || !containerRef.current) return;
    // Already known to be unavailable: never touch the GPU again this session.
    if (mapUnavailable) return;

    let cancelled = false;

    loadMaplibre().then(maplibregl => {
      if (cancelled || !containerRef.current) return;

      // If map already exists, just fly to new position
      if (mapRef.current) {
        mapRef.current.flyTo({ center: [latLon.lon, latLon.lat], zoom: 15, duration: 1200 });
        if (markerRef.current) {
          markerRef.current.setLngLat([latLon.lon, latLon.lat]);
        }
        return;
      }

      // Pre-flight, before MapLibre gets anywhere near our container: its
      // constructor builds the canvas FIRST and asks for a WebGL context
      // second, so letting it fail leaves a half-built canvas behind. Probing
      // first makes the fallback the user's first paint instead of a flash of
      // a broken map.
      if (!probeMapWebglSupport().supported) {
        degradeMap('probe_no_context', new Error('Failed to initialize WebGL (pre-flight probe)'));
        return;
      }

      // The probe is an optimisation, not a guarantee: it can pass and the
      // context still be refused a moment later when the GPU process is
      // contended (the reported `BindToCurrentSequence failed` case). This
      // callback is a microtask, so anything escaping it becomes an
      // *unhandled rejection* — which is exactly how this reached error
      // tracking as an uncaught error.
      const container = containerRef.current;
      // Must be listening BEFORE the constructor runs: the canvas it asks for a
      // context is created inside that call, and the driver's explanation
      // arrives as a DOM event on it. See `watchContextCreationStatus`.
      const contextStatus = watchContextCreationStatus(container);
      let map: InstanceType<typeof maplibregl.Map>;
      try {
        map = new maplibregl.Map({
          container,
          style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
          center: [latLon.lon, latLon.lat],
          zoom: 15,
          attributionControl: false,
          interactive: true,
        });
      } catch (err) {
        // `_setupContainer` already added its class, canvas and control
        // containers to our div. `mapRef` was never assigned, so the unmount
        // cleanup cannot reach them — purge them here, before the fallback
        // renders, so no frame shows a dead canvas.
        contextStatus.stop();
        purgeMapContainer(container);
        degradeMap('map_construction_failed', err);
        return;
      }

      // v6 stopped THROWING this failure, so the try/catch above no longer
      // sees it. `_setupPainter` now asks for `webgl2`, and on refusal fires an
      // `error` event carrying a `GPUInitializationError` and returns, leaving
      // `painter` undefined. The event goes out from inside the constructor,
      // before any `map.on('error')` of ours could be attached; `Evented.fire`
      // console.errors it for us (verified in the browser, not assumed), but
      // console output is not a control-flow signal we can act on. Without this
      // check the map object looks fine until the first call that touches the
      // painter throws somewhere unrelated.
      //
      // `painter` is on the public class surface, so testing it is a supported
      // read rather than a reach into internals.
      if (!map.painter) {
        // No painter means nothing will ever render, but the constructor still
        // built the canvas and control containers into our div. Same cleanup as
        // the throwing path, for the same reason.
        //
        // `remove()` can only ever run PARTWAY here, and deliberately so: it
        // reaches `this.painter.destroy()` fifth and throws on the undefined
        // painter, so the hash, the controls, the frame request and the render
        // queue are released while `_handlers.destroy()`, `setStyle(null)`, the
        // window `online` listener, the image-queue handle, the ResizeObserver
        // and the canvas listeners are not. There is no public API that gets
        // further on a painter-less map, and partial teardown beats none, so
        // this stays: `disposeMap` contains the throw, and the warning it logs
        // on this path is expected rather than a symptom to chase.
        queueMicrotask(() => disposeMap(map));
        purgeMapContainer(container);
        // Rebuilt from the DOM event rather than invented, so this path reports
        // the driver's own words. A bare `new Error(...)` here would have made
        // `describeMapInitFailure` return nothing and collapsed every v6 map
        // failure into one bucket with no `webgl_status`.
        const failure = reconstructMapInitFailure(contextStatus.statusMessage());
        contextStatus.stop();
        degradeMap('map_construction_failed', failure);
        return;
      }
      contextStatus.stop();

      // A lost context would otherwise be restored by MapLibre calling
      // `_setupPainter()` again from inside a DOM listener — where a throw is
      // beyond any try/catch of ours. Tear down deterministically instead:
      // `remove()` detaches both the lost and restored listeners, so that
      // un-catchable path can never run. Deferred out of MapLibre's own stack.
      map.on('webglcontextlost', () => {
        if (mapRef.current !== map) return;
        mapRef.current = null;
        markerRef.current = null;
        queueMicrotask(() => disposeMap(map));
        degradeMap('context_lost', new Error('Failed to initialize WebGL (context lost)'));
      });

      // Without a listener MapLibre logs style/tile fetch failures straight to
      // console.error. These are transient network problems, not map failures,
      // so keep a breadcrumb and leave the map running.
      map.on('error', e => {
        console.warn('[location-map] maplibre error:', e?.error ?? e);
      });

      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-right');

      // Add marker at model location (teal = current model position)
      const marker = new maplibregl.Marker({ color: '#14b8a6' })
        .setLngLat([latLon.lon, latLon.lat])
        .addTo(map);

      // Toggle marker vs footprint based on zoom level
      map.on('zoomend', () => {
        const zoom = map.getZoom();
        if (markerRef.current) {
          markerRef.current.getElement().style.opacity = zoom >= 17 ? '0' : '1';
          markerRef.current.getElement().style.pointerEvents = zoom >= 17 ? 'none' : 'auto';
        }
      });

      // Map click to place pin (only in edit mode)
      map.on('click', handleMapClick);

      mapRef.current = map;
      markerRef.current = marker;

      // If footprint was already computed before the map was created, add it now
      if (footprintRef.current) {
        map.once('load', () => {
          addFootprintToMap(map, footprintRef.current!);
        });
      }
    }).catch(err => {
      // The backstop. Nothing above may escape this chain: with no handler the
      // derived promise rejects unhandled and PostHog records it as an
      // uncaught, error-level exception (issue #1914). Reaching here means the
      // maplibre chunk itself failed to load, or a shape the try/catch above
      // did not cover — either way the panel degrades instead of throwing.
      if (cancelled) return;
      console.warn('[location-map] map initialisation failed:', err);
      degradeMap('map_load_failed', err);
    });

    return () => {
      cancelled = true;
    };
  }, [latLon, handleMapClick, mapUnavailable, degradeMap]);

  // Add/update building footprint GeoJSON layer when footprint or style changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!footprint) {
      removeFootprintFromMap(map);
      return;
    }

    if (map.isStyleLoaded()) {
      addFootprintToMap(map, footprint);
    } else {
      map.once('style.load', () => addFootprintToMap(map, footprint));
    }
  }, [footprint, styleVersion]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      pickedMarkerRef.current?.remove();
      pickedMarkerRef.current = null;
      markerRef.current?.remove();
      markerRef.current = null;
      // Guarded: teardown throws if the context was already lost, and an
      // uncaught throw in cleanup unmounts the properties panel around us.
      if (mapRef.current) disposeMap(mapRef.current);
      mapRef.current = null;
    };
  }, []);

  const googleMapsUrl = useMemo(() => {
    if (!latLon) return null;
    return `https://www.google.com/maps?q=${latLon.lat},${latLon.lon}`;
  }, [latLon]);

  const openStreetMapUrl = useMemo(() => {
    if (!latLon) return null;
    return `https://www.openstreetmap.org/?mlat=${latLon.lat}&mlon=${latLon.lon}#map=17/${latLon.lat}/${latLon.lon}`;
  }, [latLon]);

  const handleExportKmz = useCallback(async () => {
    if (!latLon || !geometryResult || !mapConversion || !projectedCRS) return;
    try {
      // Embed the model as COLLADA (Rust exporter): Google Earth's <Model> only loads
      // COLLADA, renders it bright via emission, and clampToGround keeps it on the
      // terrain so the MSL orthogonal height no longer floats it (#1427).
      //
      // Placement is NOT computed here. This used to call `buildKmz` directly
      // with the authored axis and a raw `orthogonalHeight`, which skipped all
      // three corrections the Export KMZ dialog got: the map-absolute guard
      // (#2526), the map-unit altitude scaling, and the RTC Z fold-back. Same
      // model, two buttons, two different files. `buildKmzForResolvedGeoref` is
      // now the single source for both (#2526 follow-up).
      const kmz = await buildKmzForResolvedGeoref({
        conversion: mapConversion,
        crs: projectedCRS,
        coordinateInfo,
        lengthUnitScale: lengthUnitScale ?? 1,
        // The COMPLETE mesh set is derived inside the builder — passing
        // `geometryResult.meshes` here dropped every GPU-instanced occurrence
        // from the exported file (#2577). The Location panel only ever shows
        // the primary model's georeference.
        geometryResult,
        // This panel only ever shows the primary model's georeference (no
        // per-model selector), and receives its `geometryResult` as a prop with
        // no accompanying idOffset/maxExpressId — `null` (no filter) mirrors the
        // pre-#2255 "isPrimary" behavior for this always-single-model view. A
        // multi-model federation could in principle leak another model's
        // instanced occurrences in here; a precise fix needs the primary
        // model's `{ idOffset, maxExpressId }` threaded in as a prop.
        instancedModelRange: null,
        name: 'IFC Model',
      }, createKmzProcessor);
      if (typeof kmz === 'string') {
        console.error('KMZ export failed:', kmz);
        return;
      }
      downloadBlob(new Blob([kmz as BlobPart], { type: 'application/vnd.google-earth.kmz' }), 'model.kmz');
    } catch (err) {
      console.error('KMZ export failed:', err);
    }
  }, [latLon, geometryResult, mapConversion, projectedCRS, coordinateInfo, lengthUnitScale, createKmzProcessor]);

  const isDarkRef = useRef(false);

  const handleStyleToggle = useCallback(() => {
    if (!mapRef.current) return;
    isDarkRef.current = !isDarkRef.current;
    mapRef.current.setStyle(
      isDarkRef.current
        ? 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
        : 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    );
    // Re-add markers and layers after style fully loads
    if (mapRef.current) {
      mapRef.current.once('style.load', () => {
        if (markerRef.current && mapRef.current) {
          markerRef.current.addTo(mapRef.current);
        }
        if (pickedMarkerRef.current && mapRef.current) {
          pickedMarkerRef.current.addTo(mapRef.current);
        }
        // Trigger footprint layer re-add
        setStyleVersion(v => v + 1);
      });
    }
  }, []);

  // Nothing to show if no georeferencing data
  if (!mapConversion || !projectedCRS) {
    return null;
  }

  return (
    <div className="border-t border-zinc-100 dark:border-zinc-900">
      {/* Header with search */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        <MapIcon className="h-3 w-3 text-teal-500 shrink-0" />
        <span className="font-bold text-[11px] text-zinc-700 dark:text-zinc-300 uppercase tracking-wide flex-1">
          Location
        </span>
        {latLon && !searchOpen && (
          <span className="text-[10px] font-mono text-teal-600/70 dark:text-teal-500/60">
            {latLon.lat.toFixed(5)}, {latLon.lon.toFixed(5)}
          </span>
        )}
        {editable && (
          <button
            onClick={() => { setSearchOpen(!searchOpen); setSearchQuery(''); setSearchResults([]); }}
            className="p-0.5 text-zinc-400 hover:text-teal-600 dark:hover:text-teal-400 transition-colors"
            title="Search for a place"
          >
            <Search className="h-3 w-3" />
          </button>
        )}
      </div>

      {/* Search bar */}
      {editable && searchOpen && (
        <div className="px-3 pb-1.5 relative">
          <div className="flex items-center gap-1">
            <div className="flex-1 relative">
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Search for a place..."
                className="w-full text-[11px] px-2 py-1 border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:ring-1 focus:ring-teal-400 focus:border-teal-400 placeholder:text-zinc-400/60"
                autoFocus
                onKeyDown={e => { if (e.key === 'Escape') { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); } }}
              />
              {searchLoading && (
                <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-teal-500 animate-spin" />
              )}
            </div>
            <button
              onClick={() => { setSearchOpen(false); setSearchQuery(''); setSearchResults([]); }}
              className="p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            >
              <X className="h-3 w-3" />
            </button>
          </div>

          {/* Search results dropdown */}
          {searchResults.length > 0 && (
            <div className="absolute left-3 right-3 top-full z-50 mt-0.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-lg max-h-[160px] overflow-y-auto">
              {searchResults.map((r, i) => (
                <button
                  key={i}
                  onClick={() => handleSearchSelect(r)}
                  className="w-full text-left px-2 py-1.5 text-[10px] text-zinc-700 dark:text-zinc-300 hover:bg-teal-50 dark:hover:bg-teal-950/50 border-b border-zinc-100 dark:border-zinc-800 last:border-0 transition-colors"
                >
                  <div className="flex items-start gap-1.5">
                    <MapPin className="h-3 w-3 text-teal-500 shrink-0 mt-0.5" />
                    <span className="line-clamp-2">{r.display_name}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Map container */}
      {mapState === 'loading' && (
        <div className="flex items-center justify-center h-[180px] bg-zinc-50 dark:bg-zinc-900/50">
          <Loader2 className="h-4 w-4 text-teal-500 animate-spin" />
          <span className="text-[10px] text-zinc-400 ml-2">Resolving coordinates...</span>
        </div>
      )}

      {mapState === 'error' && (
        <div className="flex items-center justify-center h-[60px] bg-zinc-50 dark:bg-zinc-900/50 gap-2 px-3">
          <MapPinOff className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
          <span className="text-[10px] text-zinc-400">{error}</span>
        </div>
      )}

      {(mapState === 'ready' || (mapState === 'loading' && latLon)) && (
        <>
          {mapUnavailable ? (
            /* No WebGL context on this device. Everything that does not need a
               GPU stays: the coordinate readout above, the external map links
               and the KMZ export below, and — in edit mode — place search,
               which still drives the reverse projection and the Apply button. */
            <div className="flex flex-col items-center justify-center h-[180px] bg-zinc-50 dark:bg-zinc-900/50 gap-1.5 px-4 text-center">
              <MapPinOff className="h-4 w-4 text-zinc-400" />
              <span className="text-[10px] text-zinc-500 dark:text-zinc-400">
                Map preview unavailable on this device
              </span>
              <span className="text-[9px] text-zinc-400 dark:text-zinc-500 max-w-[240px]">
                {mapUnavailable === 'map_load_failed'
                  ? 'The map component could not be loaded. Check your connection and reload the page.'
                  : 'Your browser could not provide graphics for the map. Coordinates, search and the links below still work; reloading the page may restore it.'}
              </span>
            </div>
          ) : (
            <div className="relative">
              <div
                ref={containerRef}
                className="h-[180px] w-full [&_.maplibregl-ctrl-attrib]:!text-[7px] [&_.maplibregl-ctrl-attrib]:!bg-white/40 [&_.maplibregl-ctrl-attrib]:dark:!bg-black/30 [&_.maplibregl-ctrl-attrib]:!py-0 [&_.maplibregl-ctrl-attrib]:!px-1 [&_.maplibregl-ctrl-attrib]:!shadow-none [&_.maplibregl-ctrl-attrib]:!text-zinc-400/70 [&_.maplibregl-ctrl-attrib_a]:!text-zinc-400/70 [&_.maplibregl-ctrl-attrib]:!leading-normal"
                style={{ minHeight: 180 }}
              />
              {/* Edit mode hint overlay */}
              {editable && !pickedLatLon && (
                <div className="absolute top-2 left-2 bg-white/90 dark:bg-zinc-900/90 backdrop-blur-sm px-2 py-1 text-[9px] text-zinc-500 dark:text-zinc-400 pointer-events-none shadow-sm border border-zinc-200/50 dark:border-zinc-700/50">
                  Click map to place pin
                </div>
              )}
            </div>
          )}

          {/* Picked position info bar */}
          {pickedLatLon && editable && (
            <div className="bg-purple-50/80 dark:bg-purple-950/30 border-t border-purple-200/50 dark:border-purple-800/30 px-3 py-2">
              <div className="flex items-center gap-2 mb-1.5">
                <MapPin className="h-3 w-3 text-purple-600 dark:text-purple-400 shrink-0" />
                <span className="text-[10px] font-semibold text-purple-700 dark:text-purple-300 flex-1">
                  New Position
                </span>
                <button
                  onClick={handleClearPick}
                  className="p-0.5 text-purple-400 hover:text-purple-600 dark:hover:text-purple-300 transition-colors"
                  title="Remove pin"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono mb-2">
                <div className="text-zinc-500 dark:text-zinc-400">Lat/Lon</div>
                <div className="text-purple-700 dark:text-purple-300 text-right">
                  {pickedLatLon.lat.toFixed(6)}, {pickedLatLon.lon.toFixed(6)}
                </div>

                {projectedCoords && (
                  <>
                    <div className="text-zinc-500 dark:text-zinc-400">Easting</div>
                    <div className="text-purple-700 dark:text-purple-300 text-right tabular-nums">
                      {projectedCoords.easting.toFixed(3)}
                    </div>
                    <div className="text-zinc-500 dark:text-zinc-400">Northing</div>
                    <div className="text-purple-700 dark:text-purple-300 text-right tabular-nums">
                      {projectedCoords.northing.toFixed(3)}
                    </div>
                  </>
                )}

                <div className="text-zinc-500 dark:text-zinc-400 flex items-center gap-1">
                  <Mountain className="h-2.5 w-2.5" />
                  Elevation
                </div>
                <div className="text-purple-700 dark:text-purple-300 text-right tabular-nums">
                  {elevationLoading ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin inline" />
                  ) : pickedElevation !== null ? (
                    `${pickedElevation.toFixed(1)} m`
                  ) : (
                    <span className="text-zinc-400">—</span>
                  )}
                </div>
              </div>

              {/* Apply button */}
              {onApplyPosition && projectedCoords && (
                <button
                  onClick={handleApply}
                  disabled={elevationLoading}
                  className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold text-white bg-purple-600 hover:bg-purple-700 dark:bg-purple-700 dark:hover:bg-purple-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Check className="h-3 w-3" />
                  Apply to Eastings / Northings
                  {pickedElevation !== null && ' / Height'}
                </button>
              )}
            </div>
          )}

          {/* Action links */}
          <div className="flex items-center gap-3 px-3 py-1.5 border-t border-zinc-100 dark:border-zinc-900">
            {googleMapsUrl && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={googleMapsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[10px] text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 transition-colors"
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                    Google Maps
                  </a>
                </TooltipTrigger>
                <TooltipContent>Open model location in Google Maps</TooltipContent>
              </Tooltip>
            )}
            {openStreetMapUrl && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <a
                    href={openStreetMapUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-[10px] text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 transition-colors"
                  >
                    <ExternalLink className="h-2.5 w-2.5" />
                    OpenStreetMap
                  </a>
                </TooltipTrigger>
                <TooltipContent>Open model location in OpenStreetMap</TooltipContent>
              </Tooltip>
            )}
            {geometryResult && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={handleExportKmz}
                    className="flex items-center gap-1 text-[10px] text-teal-600 dark:text-teal-400 hover:text-teal-800 dark:hover:text-teal-300 transition-colors"
                  >
                    <Globe2 className="h-2.5 w-2.5" />
                    Google Earth
                  </button>
                </TooltipTrigger>
                <TooltipContent>Download KMZ for Google Earth Pro (desktop), placed at the model location. Google Earth on the web cannot show KMZ 3D models — use Export GLB for the web.</TooltipContent>
              </Tooltip>
            )}
            {/* Hidden without a map: it would be a permanent no-op. */}
            {!mapUnavailable && (
              <button
                onClick={handleStyleToggle}
                className="ml-auto text-[10px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
              >
                Toggle style
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
