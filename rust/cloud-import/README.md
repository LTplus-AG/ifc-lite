# IFC-Lite cloud import

Native Rust conversion of an immutable Autodesk Forma element snapshot into IFCX. The service fetches authorized elements and bounded GLB blobs into a private workspace; this converter performs the domain normalization. Run `cargo build --release -p ifc-lite-cloud-import`, then configure `AUTODESK_FORMA_CONVERTER` with the binary's absolute path.

Usage: `ifc-lite-cloud-import snapshot.json model.ifcx`. The manifest contains `revisionId`, `elements`, `site` and a `blobs` map from blob ID to a basename in the manifest directory. It contains no OAuth token. External GLB buffers and filesystem traversal are rejected. Iterative walks bound depth, cycles, occurrences and vertex counts. Selection supports mesh-name equality and prefixes, including older `id` links.

Transforms apply glTF node transforms, Y-up to Z-up conversion, then Forma occurrence transforms. Each child-key path becomes a separate selectable entity. Source properties, metadata and representations survive in IFCX. Projected coordinates use the site's metre-based SRID/reference point; Forma's height above mean sea level remains unshifted. Color/opacity are imported. Current limitations recorded in the artifact and UI include textures, vertex colors, skins/morph targets and 2D terrain overlays. Visible terrain supplied as a volume mesh follows the same import path as other geometry.

The converter tests binary GLB invariants; the Node service CI also passes converted IFCX through the real IFClite parser. Account-backed source-versus-import qualification remains a separate live check.
