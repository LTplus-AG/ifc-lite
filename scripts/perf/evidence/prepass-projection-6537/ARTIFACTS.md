# Archived evidence identity (#6537)

Packaging source: `0339c7ae563a66b3638dd1d347c49e6f0a469d6e`. All 15 newly compressed files decode byte-for-byte to that commit's original artifacts; gzip timestamps are zero. The two existing result archives retain their original compressed bytes. Historical provenance continues to name the uncompressed filenames and hashes.

Read any capture with `gzip -dc <artifact>.gz`. Archive contents are historical evidence, including the standalone diagnostic harnesses and dependency lock; no repository task compiles or executes these archive files.

| Archive | Compressed bytes | Compressed SHA-256 | Decoded bytes | Decoded SHA-256 |
| --- | ---: | --- | ---: | --- |
| `Cargo.lock.gz` | 2021 | `726b4803feafb70cd2d25939ab0f751f31b1443cec95efe72843499dc586324b` | 7263 | `b045d9fb615dbbedbad11f85adec8e6a806cc1072f253f728b630c9ea87152ae` |
| `build.log.gz` | 525 | `d7af0894f4652d754efd02586aa7fe1f95eb7f3c56dc59e9aa540648555dc9c1` | 1287 | `359a382421f09c5790ba9b0d1915298e8705ffd421b5edf72cd05068e18329a6` |
| `census.rs.gz` | 1915 | `89e83afbd9073416073deb40e6d5d857ead3fd0ce909a5e4a3ebb83abedd2be8` | 4191 | `2ff410a6f7d9e08486594f65b8e5ad04d8e5f1607cc7b68da036a35b863efa9c` |
| `clippy.log.gz` | 420 | `7835d1f69ae9d71850bd1c7f78dc55f2473df3fc55dd18c966023cab8dfd24d5` | 1012 | `6c8bd7ae5f278e3757fdc706f4d310a7bf722161b86b0ae65fa753a8cf534752` |
| `construction-census.rs.gz` | 2338 | `9c747fb9a17f42125d5ab8ad83c13c66d6b6f80c45575c984e4bc431b697d787` | 6688 | `d5de5060008eeb9ff7be2de00cacfe0d2f7b56a000edb332623314a46ad61142` |
| `current-qualification.json.gz` | 1989 | `8e9d6f8ff48cf11360692752be80670e634adb8724f3c1240ad2d6d5c0aee565` | 4756 | `866b0c83ff89c5692e55de8e980cbe22bd3f230422e9347316a14222f331cc93` |
| `current-workspace-clippy.log.gz` | 263 | `e72ac39565fd496706e76ccd9317257037f37e17a07ba249b8f8e546816f3931` | 1106 | `6b0364aa9d66c96ee893c8d91ca54052a53c5551a4bf729577717be9781b2ceb` |
| `medical-download-provenance.json.gz` | 713 | `dafd15af35b3b9fc992cb6283505e58c6651f41d50a620a8f495097b74012ca7` | 1139 | `5abd4f3cb2c6869c7151f207ceb1f46e162bc56ee33752a6aaec3b74e493610b` |
| `prepass-construction-census-build.log.gz` | 975 | `ab01e42d20be550de2ccaacf58a3fb216edf8ae585455374c2c65b8af1d5f6b7` | 3014 | `77e876e298c334a8b3e4621e4d9538b84b91b7841eed748c219f0c7f9440d520` |
| `prepass-revit-census-postflight.json.gz` | 411 | `3c02369252a1be3f69d8418221dbbf6272d9cef5f91f9c5839538eeffa3acf5b` | 750 | `87b4bfdfac2d627345ff772b4cbc83de9551350171ffd2458c8c0f0c99fa4242` |
| `prepass-revit-census-preflight.json.gz` | 411 | `e8a1f65a198e7df7a91f09d8ac570346cc0387fe9b46b7cfdff93957ec7dc0ac` | 750 | `38b78cbee25d7739a700f34199d8fe77556c0ae0cdbd7471cea6a2fff0a638f9` |
| `prepass-revit-construction-census-provenance.json.gz` | 928 | `c5e496a7300f4924283524f502962ae1375e8cfdf14cb13b7206032078d92c5f` | 1794 | `3bd804d26d7cdaac1f9b5cfdee5977c65b1c23eb13433ef9f845e2615eda4cf4` |
| `prepass-revit-construction-census.json.gz` | 1299 | `d44592e29ef0e912c65b5d3e3559f389fb14275d63bd2a20538d8aa0bda855a3` | 7737 | `6b1a6d2147aa968a919cdef8bb03445beac0d299405d7a1b7a604e42e99bd27f` |
| `provenance.json.gz` | 1224 | `b3186d437f383fe88b276b34c88bd1e3cf0fcaa7dde3341d3027ee32bfda92a9` | 2443 | `bf8ee5041bd17d25a396cfaafc172b1a3858885a3481a729a91eb34318c26eb6` |
| `publication-provenance.json.gz` | 1407 | `65fa8a755fbb6aa7f1ab93f36fae183404aade949dc642629c5be324c7f04b50` | 3173 | `b2b2914af3512b55882a14cd7e1a6a2423e8bcf63c89c519e9263f6206dcd8e8` |
| `results.json.gz` | 1881 | `f5807cb25d375131b086926f8f74c9beedfbe55aad2ab34043a2edf05dc62a95` | 14242 | `2183d62c1d61b876f622ba892b807a60e5b60b5732e83876b64b8e5712c93922` |
| `snowdon-download-provenance.json.gz` | 536 | `d59f6d925f09a8f1c31f41dcf4bfcb98eccd8fe210814d175f2e9548e78104cd` | 778 | `97e4fc7072fea3976c48a034e4c29a806b2dd0c1bf0ff1ffdfbdd0545f3c8b0e` |

The original and current strict Clippy/build receipts are retained unchanged inside their named archives. Packaging establishes lossless archival identity; it does not rerun or extend those recorded qualifications.
