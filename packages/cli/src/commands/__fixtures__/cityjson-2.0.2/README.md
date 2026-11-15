# CityJSON 2.0.2 JSON schemas (vendored)

`cityjson.min.schema.json` and `cityjsonfeature.min.schema.json` are the
official single-file CityJSON 2.0 schemas, copied unmodified from
[cityjson/specs](https://github.com/cityjson/specs) at tag `2.0.2`
(commit `877ee49e16c82a4bc7ab598926efcb9ba1075374`), `schemas/`.

The specification says a CityJSON object names only its minor version
(`"version": "2.0"`) and is validated against the latest schema of that minor
version, which is 2.0.2.

Licence: CC0 1.0 Universal (`LICENSE`, copied from the same tag).

Used by `export-cityjson.test.ts` to validate `ifc-lite export --format
cityjson|cityjsonseq` output with ajv (draft-07).
