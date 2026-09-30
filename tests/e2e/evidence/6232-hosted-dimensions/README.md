# Hosted inspector dimension edits (#6232)

Real T3 browser/WebGPU run against the committed Bonsai export
`apps/viewer/public/samples/hello-wall.ifc` on 2026-09-30. The browser served
TypeScript source commit `80b67d8c239062c654b5926aa7d094294f4f7ed7` and a real
WASM runtime built from Rust commit `526a91bdf33e2be2d6167df95a68db343b5337c0`.
The served runtime matched the local artifact by SHA-256. These captures precede
the final integration with main; they establish the accepted implementation's
browser behavior, rather than a browser rerun of the later merge commit.

- Model SHA-256: `0ab20f4ea355ea9aa4fade7264b97ee9f9929addfa3961b2437c4381bd674014`.
- WASM SHA-256: `4a4b4039aa3836b0a3de079757eba202ad1f507740bf3a2aae882bbfffc6152d`.

The user-facing Width and Height inputs changed selected window #1262 from
0.90 × 1.20 m to 1.20 × 1.40 m. The renderer retained the horizontal centre,
1.00 m sill and 0.05 m depth, while the host wall #1222 was remeshed with its
enlarged cut. Other window #1407 retained its bounds and world triangle positions.
`edited-width-height.png` shows the edited inspector and actual GPU viewport.

Clicking Undo twice restored the selected window, its host and the other window.
The complete serialized scene-owner data, including world triangle positions,
screen data and render flags, matched the initial data exactly. Undo becoming
disabled after those two clicks was observed in the actual UI, independently of
the saved scene data. `restored-after-two-undos.png` shows the restored
0.90 × 1.20 m fields and viewport; it is a restored-state capture, not an
initial-state screenshot.

`facts.json` records the initial, edited, first-undo and restored bounds,
world-triangle-position hashes and render-state flag hashes, plus full
scene-owner equality results and the separately observed UI state. The browser
renderer uses Y-up coordinates, so bounds index 1 is height and index 2 is depth.
`cornersHash` hashes the actual world triangle positions. `flatHash` and
`instanceHash` hash boolean flags; they do not measure GPU upload bytes.
These browser captures do not assert normals or index-buffer byte identity.

The automated regression tests separately exercise real WASM meshes of this
export, full vertex/index/style identity for the unaffected instance,
40 alternating dimension edits, wrapper styles, atomic refusals, and
mounted inspector edits in one- and multiple-model scenes with colliding local
entity ids. Their integration-run results belong to the PR validation report.
