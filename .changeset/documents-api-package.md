---
'@ifc-lite/documents-api': minor
---

Add `@ifc-lite/documents-api`: client for the buildingSMART OpenCDE Documents API 1.0. `DocumentsApiClient` covers discovery via `@ifc-lite/opencde-foundation`'s `/foundation/versions`, the document-selection flow (`selectDocuments` → the CDE's select-documents UI → `parseSelectDocumentsCallback` → `getSelectedDocuments`), fetching document metadata/versions and downloading a document version, polling for the latest version of a tracked set of documents (`queryDocumentVersions`, with `If-None-Match`/304 support, returning the response ETag to send on the next poll), and the full upload flow (`uploadDocuments` → `parseUploadDocumentsCallback` → `getUploadInstructions` → `uploadFilePart` for each server-specified byte range, including the `multipart_form_data` prefix/suffix wrapping → `completeUpload`/`cancelUpload`).
