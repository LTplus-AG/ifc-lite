# Solibri BCF filename qualification — #6459

Solibri Office 26.9.0.123 was exercised on Windows through Communication →
New Presentation → From BCF File. Each run used its matching filename filter
and a separately named presentation. The original public [bisection kit](https://github.com/user-attachments/files/32345129/bcf-3612-solibri-bisection-kit.zip)
was downloaded, hashed and preserved unchanged.

| Archive contents | `.bcf` topics | Byte-identical `.bcfzip` topics |
| --- | ---: | ---: |
| Original IFClite A0 | 1 | 0 |
| Original Solibri S0 | 1 | 0 |
| Fresh export from the changed viewer | 1 | 0 |

The reciprocal S0 control is significant: Solibri also silently refuses its
own 2.1 contents when the filename selects `.bcfzip`. Its [official extension
contract](https://solibri.github.io/Developer-Platform/latest/superrun-actions.html#export_bcf)
uses `.bcf` for 2.1/3.0 and `.bcfzip` for 1.0/2.0. No ZIP-header or XML rewrite
was needed for these native acceptance results.

The catalogued `buildingsmart/Building-Architecture.ifc` was fetched by its
manifest SHA256 and loaded separately for viewpoint qualification. Its project
and both selected-component GUIDs match the archives. Earlier observations on
Solibri's unrelated default model are not selection/camera acceptance.

On the matching model, A0 imports one topic and restores its camera, one
selected component, the viewpoint-linked comment and its clipping plane.
Removing sectioning reveals the full roof at the same camera; switching away
and selecting A0 again restores the actual cut. S0 restores its closer camera,
one selection and blue component coloring without a section plane, as its
source contains no clipping plane or comment.

The changed viewer loaded the same IFC and imported A0 through the ordinary
panel. Its actual Export BCF action produced `Building-Architecture_Topics.bcf`.
The generated browser Blob was retained locally at the download boundary and
imported into Solibri: one topic, one selected component, the linked comment
and actual sectioning restored. The topic GUID, camera values, selection,
clipping values, comment/viewpoint link and snapshot hash match A0. Renaming
that exact generated Blob to `.bcfzip` again produces zero topics.

`receipt.json` records artifact and producer identities. Raw application
screenshots and saved Solibri projects remain private because they contain
account/license or author details. This is an executed 26.9 result, not a
claimed execution on the reporter's historical 26.6.1. Native vendor execution
covers 2.1; 3.0 has real ZIP round-trip component coverage and the documented
extension contract.
