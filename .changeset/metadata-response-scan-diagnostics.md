---
'@ifc-lite/server-client': patch
---

`MetadataResponse` now carries `oversized_id_count` and `malformed_record_found`, so a client can tell a whole file from a truncated one.

`POST /api/v1/parse/metadata` walks its own entity scanner and returned a 200 whose `entity_count` was computed over the bytes before the scan stopped. Both ways that happens were invisible to the caller: a record whose instance name does not fit `u32` is skipped (#3395), and a record with no terminating `;` — an unterminated string or comment, or a truncated file — stops the scan outright (#3695). A model that came back short read exactly like a small one.

The server now reports both to its own sink and puts both on the response. Counting behaviour is unchanged; only the silence is fixed. `oversized_id_count > 0` means `entity_count` is short by that many records; `malformed_record_found === true` means it covers only the bytes before the break, so the answer is a partial view of the file rather than a smaller file.
