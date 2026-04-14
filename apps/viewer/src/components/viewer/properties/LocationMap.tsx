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
import type { CoordinateInfo, GeometryResult } from '@ifc-lite/geometry';
import { GLTFExporter } from '@ifc-lite/export';
import { reprojectToLatLon, reprojectFromLatLon, queryTerrainElevation, computeFootprintGeoJSON, type LatLon } from '@/lib/geo/reproject';
import { buildKmz, ifcAngleToKmlHeading } from '@/lib/geo/kmz-exporter';

// Lazy-load maplibre-gl to avoid bloating the initial bundle
let maplibrePromise: Promise<typeof import('maplibre-gl')> | null = null;
function loadMaplibre() {
  if (!maplibrePromise) {
    maplibrePromise = import('maplibre-gl');
  }
  return maplibrePromise;
}

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
}

type MapState = 'idle' | 'loading' | 'ready' | 'error';

// Debounce helper
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/** Geocode a query string via Nominatim */
async function geocodeSearch(query: string): Promise<Array<{ lat: number; lon: number; display_name: string }>> {
  if (!query.trim()) return [];
  try {
    const q = encodeURIComponent(query.trim());
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${q}`,
      { headers: { 'Accept-Language': 'en' } },
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.map((r: { lat: string; lon: string; display_name: string }) => ({
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
      display_name: r.display_name,
    }));
  } catch {
    return [];
  }
}

/** Add or update the building footprint GeoJSON polygon on a MapLibre map */
function addFootprintToMap(map: InstanceType<typeof import('maplibre-gl').Map>, ring: [number, number][]) {
  const geojson: GeoJSON.Feature = {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'Polygon',
      coordinates: [ring],
    },
  };

  if (map.getSource('building-footprint')) {
    (map.getSource('building-footprint') as import('maplibre-gl').GeoJSONSource).setData(geojson);
    return;
  }

  map.addSource('building-footprint', { type: 'geojson', data: geojson });

  map.addLayer({
    id: 'building-footprint-fill',
    type: 'fill',
    source: 'building-footprint',
    paint: {
      'fill-color': '#14b8a6',
      'fill-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 0.15, 18, 0.25],
    },
  });

  map.addLayer({
    id: 'building-footprint-outline',
    type: 'line',
    source: 'building-footprint',
    paint: {
      'line-color': '#0d9488',
      'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.5, 18, 2.5],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16, 0.7, 18, 1],
    },
  });

}

/** Remove footprint layers and source from a MapLibre map */
function removeFootprintFromMap(map: InstanceType<typeof import('maplibre-gl').Map>) {
  if (map.getLayer('building-footprint-outline')) map.removeLayer('building-footprint-outline');
  if (map.getLayer('building-footprint-fill')) map.removeLayer('building-footprint-fill');
  if (map.getSource('building-footprint')) map.removeSource('building-footprint');
}

export function LocationMap({
  mapConversion, projectedCRS, coordinateInfo, geometryResult,
  lengthUnitScale = 1, editable, onApplyPosition,
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

  // Picked position state (user-placed pin)
  const [pickedLatLon, setPickedLatLon] = useState<LatLon | null>(null);
  const [pickedElevation, setPickedElevation] = useState<number | null>(null);
  const [elevationLoading, setElevationLoading] = useState(false);
  const [projectedCoords, setProjectedCoords] = useState<{ easting: number; northing: number } | null>(null);

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ lat: number; lon: number; display_name: string }>>([]);
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
    loadMaplibre().then(ml => updatePickedMarker(pos, ml));
  }, [updatePickedMarker]);

  // Handle search result selection
  const handleSearchSelect = useCallback((result: { lat: number; lon: number; display_name: string }) => {
    const pos = { lat: result.lat, lon: result.lon };
    setPickedLatLon(pos);
    setSearchOpen(false);
    setSearchQuery('');
    setSearchResults([]);

    loadMaplibre().then(ml => {
      updatePickedMarker(pos, ml);
      mapRef.current?.flyTo({ center: [pos.lon, pos.lat], zoom: 16, duration: 1200 });
    });
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

      // Create new map
      const map = new maplibregl.Map({
        container: containerRef.current,
        style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
        center: [latLon.lon, latLon.lat],
        zoom: 15,
        attributionControl: false,
        interactive: true,
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
    });

    return () => {
      cancelled = true;
    };
  }, [latLon, handleMapClick]);

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
      mapRef.current?.remove();
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

  const handleExportKmz = useCallback(() => {
    if (!latLon || !geometryResult || !mapConversion) return;
    try {
      const exporter = new GLTFExporter(geometryResult);
      const glb = new Uint8Array(exporter.exportGLB({ includeMetadata: true }));
      const heading = ifcAngleToKmlHeading(mapConversion.xAxisAbscissa, mapConversion.xAxisOrdinate);
      const kmz = buildKmz({
        latLon,
        altitude: mapConversion.orthogonalHeight,
        heading,
        glb,
        name: 'IFC Model',
      });
      const blob = new Blob([kmz as BlobPart], { type: 'application/vnd.google-earth.kmz' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'model.kmz';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('KMZ export failed:', err);
    }
  }, [latLon, geometryResult, mapConversion]);

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
                <TooltipContent>Download KMZ to open in Google Earth with model at correct position</TooltipContent>
              </Tooltip>
            )}
            <button
              onClick={handleStyleToggle}
              className="ml-auto text-[10px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
            >
              Toggle style
            </button>
          </div>
        </>
      )}
    </div>
  );
}
