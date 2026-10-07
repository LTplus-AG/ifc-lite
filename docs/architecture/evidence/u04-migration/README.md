# U04 native browser verification (#6927)

Captured in T3's native collaborative browser on 2026-10-07 at 1280×800, using the committed `apps/viewer/public/samples/building-architecture.ifc` model (444 entities, 12 geometry elements, WebGPU). No live provider request was used.

`expanded-changes.png` shows the actual 31-change migration list with Keep and Reset visible (both controls end at y=428.67 in an 800-pixel viewport). The legacy layout included an unavailable `extension:campaign-preview` after Clash, hidden. Keep dismissed the notice; reloading retained that anchor and hidden state and the exact 143-character original backup.

`reset.png` shows the loaded model after the native Reset action. Browser inspection confirmed the default panel order and 22% width, the unavailable placement still preserved after Clash, and the unchanged original backup for this independent Reset case. Mounted tests exercise both actions and the native workspace reset epoch; storage tests verify that a denied backup write never overwrites the original layout.

These captures verify local behavior. They do not claim independent coordinator or extension-author acceptance.


The mobile captures verify the reviewed migration implementation on source
`2573ef59751482c9c719b544de8e83e26daeb194` at 390×844 CSS pixels, also in T3's
native browser with the committed building-architecture model loaded. The
expanded 32-change list scrolls; Keep and Reset remain visible at y=328.
`mobile-expanded-changes.png` shows that state. Keep survives reload without a
notice and retains the unknown placement and exact original backup.
`mobile-reset.png` shows an independent Reset case: expanded defaults, 22% width,
and the unknown hidden placement after `ids` retained alongside the original
backup. The native mounted mobile regression exercises both controls through
`ViewerLayout`, rather than mounting the notice alone.
