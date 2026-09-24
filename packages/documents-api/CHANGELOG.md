# @ifc-lite/documents-api

## 0.2.0

### Minor Changes

- [#5438](https://github.com/LTplus-AG/ifc-lite/pull/5438) [`3edd57d`](https://github.com/LTplus-AG/ifc-lite/commit/3edd57d9bf0b4fddb28da3401bc5cf0189756729) Thanks [@louistrue](https://github.com/louistrue)! - Add `@ifc-lite/documents-api`: client for the buildingSMART OpenCDE Documents API 1.0. `DocumentsApiClient` covers discovery via `@ifc-lite/opencde-foundation`'s `/foundation/versions`, the document-selection flow (`selectDocuments` → the CDE's select-documents UI → `parseSelectDocumentsCallback` → `getSelectedDocuments`), fetching document metadata/versions and downloading a document version, polling for the latest version of a tracked set of documents (`queryDocumentVersions`, with `If-None-Match`/304 support, returning the response ETag to send on the next poll), and the full upload flow (`uploadDocuments` → `parseUploadDocumentsCallback` → `getUploadInstructions` → `uploadFilePart` for each server-specified byte range, including the `multipart_form_data` prefix/suffix wrapping → `completeUpload`/`cancelUpload`).

### Patch Changes

- Updated dependencies [[`3edd57d`](https://github.com/LTplus-AG/ifc-lite/commit/3edd57d9bf0b4fddb28da3401bc5cf0189756729)]:
  - @ifc-lite/opencde-foundation@0.2.0
