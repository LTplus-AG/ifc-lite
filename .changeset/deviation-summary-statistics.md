---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": minor
---

Add summary statistics to the BIM ↔ scan deviation analysis (#6872). The renderer exports `computeDeviationStatistics` and the sliced, abortable `computeDeviationStatisticsAsync`, `countWithinToleranceAsync`, `deviationHistogramAsync` and `summarizeDeviationAssetsAsync`, plus `Renderer.readDeviationDistances()`, which reads every computed point's signed distance into one array grouped by scan asset. Percentiles are exact, by a radix select that copies nothing, and the async variants yield to the event loop every few milliseconds. Statistics cover mean, mean and RMS of |d|, standard deviation, exact P50/P95/P99 and max of |d|, the share within a tolerance, points at the compute clip, and a histogram over the colour ramp's range. `DeviationAssetStats` gains a `statistics` field. The viewer's Deviation panel shows these figures with a tolerance input and a ramp-coloured histogram, and its CSV export reports them per scan asset with a pooled row for several assets.
