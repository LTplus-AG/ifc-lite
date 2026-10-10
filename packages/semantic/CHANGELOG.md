# @ifc-lite/semantic

## 0.2.0

### Minor Changes

- [#6785](https://github.com/LTplus-AG/ifc-lite/pull/6785) [`7dfc298`](https://github.com/LTplus-AG/ifc-lite/commit/7dfc29870b0aa6a593c163592fcb84a92e5dfa19) Thanks [@louistrue](https://github.com/louistrue)! - Add explicit resource URI identity resolution using a full `{GlobalId}` template or the last URI path segment. Reuse revision/model scoping and ambiguity handling, preserve RDF identifiers, and support portable viewer configuration and reverse queries without a GlobalId property.

- [#7000](https://github.com/LTplus-AG/ifc-lite/pull/7000) [`3ae2e70`](https://github.com/LTplus-AG/ifc-lite/commit/3ae2e70f2fddd42aee87ac3402c740ccd2fa0ed9) Thanks [@louistrue](https://github.com/louistrue)! - Add `inspectReadOnlyQuery`, which applies the same read-only refusals as `assertReadOnlyQuery` and also returns the query form, the outer projected variables (or `'*'`) and the outer LIMIT, so a caller can check a drafted query against its declared shape before running it ([#6920](https://github.com/LTplus-AG/ifc-lite/issues/6920)).

- [#6645](https://github.com/LTplus-AG/ifc-lite/pull/6645) [`09745f0`](https://github.com/LTplus-AG/ifc-lite/commit/09745f0f3bb99ac07802ae061f13df92e865683f) Thanks [@louistrue](https://github.com/louistrue)! - Add shared semantic datasets, profile validation, read-only SPARQL providers, portable workspaces and model revision identity strategies. Expose the canonical capability-gated network implementation through a lightweight sandbox/network entry point.

- [#6786](https://github.com/LTplus-AG/ifc-lite/pull/6786) [`f04a972`](https://github.com/LTplus-AG/ifc-lite/commit/f04a97289d3130a1d7dc9df056c8b9c5b6d25791) Thanks [@louistrue](https://github.com/louistrue)! - Support explicit authorization for exact literal loopback HTTP origins in shared networking and semantic providers, CLI queries and fixed relay upstreams. Preserve HTTPS defaults, exact host grants, redirect denial and request limits. The viewer local grant is ephemeral and cancels pending retrievals when revoked; portable local endpoint settings never restore authority.

### Patch Changes

- [#6704](https://github.com/LTplus-AG/ifc-lite/pull/6704) [`9d07c95`](https://github.com/LTplus-AG/ifc-lite/commit/9d07c9521aa28827087d73959ba5087d974a6d19) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Malformed percent-escapes and unparseable request targets no longer escape as a bare `URIError` or `TypeError`. The collab server answers a request target `new URL` rejects with 400 instead of 500, closes a websocket with a malformed room path with 4400 instead of 1011, and the blob-GC scan reads each room log by its file name instead of decoding the name into a room id (a log with a malformed name is read, or named in the abort message, instead of stopping the sweep with `URI malformed`). The MCP entity resource answers a malformed GlobalId as "no such entity", and the Speckle URL parser refuses it with its named "no usable id" error, and the semantic relay's HTTPS listener answers an unparseable request target with 400 instead of 500.
  
  Add `FilePersistence.loadLogFile(file, requireComplete?)` for reading an enumerated log by its actual path. Blob GC requires complete framing and refuses incomplete frame bodies or trailing partial headers, while ordinary room loads retain complete-prefix recovery.
- Updated dependencies [[`b2a5fb2`](https://github.com/LTplus-AG/ifc-lite/commit/b2a5fb2b97290bb39d2d36be81dd416c15c6a849), [`0e2f612`](https://github.com/LTplus-AG/ifc-lite/commit/0e2f612fe205f08ab10314abd95f0319dba2cba5), [`b92dd05`](https://github.com/LTplus-AG/ifc-lite/commit/b92dd05495094a47c4a68eb1137a3a1906fc65cc), [`29e1088`](https://github.com/LTplus-AG/ifc-lite/commit/29e1088dda6777f7086bd122208ce7bda8db1d89), [`09745f0`](https://github.com/LTplus-AG/ifc-lite/commit/09745f0f3bb99ac07802ae061f13df92e865683f), [`f04a972`](https://github.com/LTplus-AG/ifc-lite/commit/f04a97289d3130a1d7dc9df056c8b9c5b6d25791), [`fe3070c`](https://github.com/LTplus-AG/ifc-lite/commit/fe3070cfb18853dd857554615160806a607dbae2), [`1bb0fe3`](https://github.com/LTplus-AG/ifc-lite/commit/1bb0fe34c8fc46acef6e51f3792f274e1e5be1b9)]:
  - @ifc-lite/sandbox@2.11.0
  - @ifc-lite/extensions@0.11.0
