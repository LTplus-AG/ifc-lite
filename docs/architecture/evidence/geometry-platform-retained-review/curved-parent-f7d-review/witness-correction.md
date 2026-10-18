<!-- SPDX-License-Identifier: MPL-2.0 -->
# Correction to the duplicate-cache witness

The source review's proposed duplicate-prewarm reproduction is withdrawn. The
pinned `EntityDecoder::decode_at` explicitly refuses to populate a SourceBundle
decoder's canonical ID cache from an earlier duplicate span. The direct record
remains readable, but a subsequent ID lookup selects the canonical last record.
`decode_at_with_id` does not bypass that rule. The core invariant already has a
behavioral test, `direct_duplicate_reads_cannot_override_canonical_id_cache`.

The earlier parent review overlooked that guard. Its static trace and the
inherited retained-admission test's expected first-record results were invalid;
neither was executed evidence. Original reports and hashes remain unchanged to
preserve what was inspected and claimed at that time.

Same-context configuration reuse is a separate, valid concern. Supported
`seed_unit_scales` calls change a decoder's execution generation while preserving
its authenticated source identity. Two legitimate decoders can therefore have
different effective scale configurations. A snapshot-only OnceLock does not
distinguish those inputs. The corrected candidate uses an actual decoder and
configuration identity, with tests for both admission orders, repeated reuse,
scale changes and cache clear/drain/import generations.

The child reports corrected source at `6f30e7c1da`. Those new tests remain unrun,
and the candidate is not yet integrated here. The running parent check uses
`082aab27df`, which still contains the invalid duplicate-prewarm assertion.
That check cannot qualify the corrected candidate. New source review and actual
execution must establish its result; changing the core canonical-cache rule to
make the old test pass would be a production regression.
