---
"@ifc-lite/cli": minor
---

New `ifc-lite oci push <oci://host/repository:tag> <model.ifc>` publishes an IFC file to an OCI registry in the layout the ifc-lite viewer publishes: artifact type `application/vnd.ifc-lite.ifc.v1`, the OCI empty config, and one `application/x-step` layer titled with the file name. The file is checked as IFC before any request, an existing tag is refused unless `--overwrite` is passed, `--annotation key=value` adds manifest annotations, and `SOURCE_DATE_EPOCH` makes the manifest reproducible. Credentials come from the same environment variables as `oci://` input. `--json` prints the manifest and layer digests. IFCZIP files are not supported for publishing yet.
