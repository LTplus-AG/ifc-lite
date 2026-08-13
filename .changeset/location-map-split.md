---
"@ifc-lite/viewer": patch
---

Split the Location panel's helpers out of `LocationMap.tsx`, and cover them with tests they never had.

`LocationMap.tsx` was past the ~400-line rule and kept growing. Four units that had no business living inside a component moved out: MapLibre load/dispose/purge (`location-map-lifecycle`), the footprint polygon's matched add/remove pair (`location-map-footprint`), Nominatim place search (`location-map-geocode`), and the generic `useDebouncedValue` hook.

None of them had a single test before. They do now, covering the parts that actually bite: the footprint pair must leave nothing behind, because MapLibre throws on a duplicate source and the panel re-runs this on every style toggle; the geocoder must resolve to `[]` rather than reject on a rate-limit, an offline network or an HTML error page, because the panel calls it from an effect with no rejection handling; the debounce must DROP intermediate values, not merely delay them, or it would still hammer the geocoder per keystroke; and the map teardown must contain a throw from `map.remove()`, because it runs from an effect cleanup where an escaping error would strand the panel half torn down.
