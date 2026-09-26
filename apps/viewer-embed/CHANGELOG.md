# @ifc-lite/viewer-embed

## 1.15.14

### Patch Changes

- [#5986](https://github.com/LTplus-AG/ifc-lite/pull/5986) [`50ffd9f`](https://github.com/LTplus-AG/ifc-lite/commit/50ffd9fab110f47411994e3ab47d5dcf0edc57dc) Thanks [@louistrue](https://github.com/louistrue)! - The overlay colour tokens are published wherever the viewer store exists, not only by the full viewer app ([#5490](https://github.com/LTplus-AG/ifc-lite/issues/5490)). The embed's axis helper was transparent because nothing wrote the `--overlay-*` properties there; its arms, labels and origin dot now show the theme's axis colours. A focused clash pair in 3D now changes colour with the theme, so it keeps matching the Clash panel's side dots.
- Updated dependencies [[`8901816`](https://github.com/LTplus-AG/ifc-lite/commit/8901816fa9171b1af0a9af5036105db0fa72cb24), [`48e64d4`](https://github.com/LTplus-AG/ifc-lite/commit/48e64d44d418c913860c21e457d9053690ebd66c), [`50ffd9f`](https://github.com/LTplus-AG/ifc-lite/commit/50ffd9fab110f47411994e3ab47d5dcf0edc57dc), [`46efab7`](https://github.com/LTplus-AG/ifc-lite/commit/46efab72317a6f9603f236f6f4784e1c7bdb6be4), [`28ae5b0`](https://github.com/LTplus-AG/ifc-lite/commit/28ae5b0bf1ce37fd592651113f3e765caa980291), [`817e3ef`](https://github.com/LTplus-AG/ifc-lite/commit/817e3ef3fe27e26081fdc43edb1819d1e31a4919), [`9dec151`](https://github.com/LTplus-AG/ifc-lite/commit/9dec1513c91a5db36f35fcbc77b2932103e1574e), [`443e013`](https://github.com/LTplus-AG/ifc-lite/commit/443e013ac6c1b5664a43c9b5df2e5600219c706b), [`d3d2d6f`](https://github.com/LTplus-AG/ifc-lite/commit/d3d2d6fd64ef66ffb6dc4f117c188661ecfa05a5), [`96feb08`](https://github.com/LTplus-AG/ifc-lite/commit/96feb088320809beb4f4b8b572f67d9099050dd3), [`d0d79ed`](https://github.com/LTplus-AG/ifc-lite/commit/d0d79ed15415c7391640ad0660ad17f8d5ebbb5b), [`09c1970`](https://github.com/LTplus-AG/ifc-lite/commit/09c19701c4373bdda931b52d86fb4c910cfc6e2e), [`0476281`](https://github.com/LTplus-AG/ifc-lite/commit/0476281b0476ec65564e65b6fc7cfe729a3982bb), [`88b454a`](https://github.com/LTplus-AG/ifc-lite/commit/88b454a10da0f27b90799cbc1469fccf9d70a2c7), [`0476281`](https://github.com/LTplus-AG/ifc-lite/commit/0476281b0476ec65564e65b6fc7cfe729a3982bb), [`773a54f`](https://github.com/LTplus-AG/ifc-lite/commit/773a54ff450d872bc6cd49ec7e0a1108b965cf96), [`da22190`](https://github.com/LTplus-AG/ifc-lite/commit/da22190245789a7e3240b8dbb6de5717415ac448), [`013b43c`](https://github.com/LTplus-AG/ifc-lite/commit/013b43cea4d7bff58c803b7774666d8b0d122026), [`0f52c72`](https://github.com/LTplus-AG/ifc-lite/commit/0f52c72f1ff739ba9f8dc061e45223e9a1307761), [`236b076`](https://github.com/LTplus-AG/ifc-lite/commit/236b076ca7ee967691380335b4637a5be3c61562), [`efc652c`](https://github.com/LTplus-AG/ifc-lite/commit/efc652c475f71b0d884d5c746b3156516618d1e3)]:
  - @ifc-lite/data@6.1.0
  - @ifc-lite/create@3.1.1
  - @ifc-lite/export@4.7.5
  - @ifc-lite/collab@0.9.2
  - @ifc-lite/mutations@2.9.0
  - @ifc-lite/renderer@5.0.1
  - @ifc-lite/clash@2.4.3
  - @ifc-lite/wasm@10.2.0
  - @ifc-lite/drawing-2d@4.0.4
  - @ifc-lite/parser@9.0.1
  - @ifc-lite/server-client@4.0.0
  - @ifc-lite/ids@3.0.4
  - @ifc-lite/rules@0.5.0
  - @ifc-lite/lists@2.3.4
  - @ifc-lite/charts@0.6.2
  - @ifc-lite/mcp@0.22.1

## 1.15.13

### Patch Changes

- Updated dependencies [[`a51dd3d`](https://github.com/LTplus-AG/ifc-lite/commit/a51dd3de40b0921f552d0c4a8ba8b9195511d114), [`f64353f`](https://github.com/LTplus-AG/ifc-lite/commit/f64353f10fb643a664a9f3f485ef009b1d2622f8), [`66f3d7e`](https://github.com/LTplus-AG/ifc-lite/commit/66f3d7eb085e77a27e4a0bae096daa70b43620c9), [`dff671e`](https://github.com/LTplus-AG/ifc-lite/commit/dff671efe29d9bbc4a1f455fc6b0526d85fb461b), [`f34299c`](https://github.com/LTplus-AG/ifc-lite/commit/f34299ca63a368dbaa68ad911f628eabb49dbcde), [`96b0404`](https://github.com/LTplus-AG/ifc-lite/commit/96b04045f0f3708a453ed18f23c54a1a0745ed42), [`43f40a1`](https://github.com/LTplus-AG/ifc-lite/commit/43f40a12c9bad0cc3515819b204a9b41339367dc), [`f30de14`](https://github.com/LTplus-AG/ifc-lite/commit/f30de14f957df133a3b6be8aa61fea934d76956a), [`d85e898`](https://github.com/LTplus-AG/ifc-lite/commit/d85e8980fcebe59a2b6886b117056790023cb81b), [`3396e12`](https://github.com/LTplus-AG/ifc-lite/commit/3396e1241d8111c530b546659d006a35b6a5aed6)]:
  - @ifc-lite/flow-nodes@0.5.0
  - @ifc-lite/bcf@5.0.0
  - @ifc-lite/mutations@2.8.0
  - @ifc-lite/sandbox@2.8.0
  - @ifc-lite/mcp@0.22.0
  - @ifc-lite/create@3.1.0
  - @ifc-lite/export@4.7.4
  - @ifc-lite/wasm@10.1.2
  - @ifc-lite/bcf-api@0.2.4
  - @ifc-lite/clash@2.4.2
  - @ifc-lite/sdk@7.1.3
  - @ifc-lite/rules@0.4.1

## 1.15.12

### Patch Changes

- Updated dependencies [[`ca5ff8d`](https://github.com/LTplus-AG/ifc-lite/commit/ca5ff8d98979cbcadd1644e32ddad4990d178eb4), [`7fae2b8`](https://github.com/LTplus-AG/ifc-lite/commit/7fae2b8b2d6264a90af3235d95e0a4f6c257b9d7), [`bf32c6a`](https://github.com/LTplus-AG/ifc-lite/commit/bf32c6a128d9ce1c8d9d2a0efcfe7f8754c3d01c), [`e7a658d`](https://github.com/LTplus-AG/ifc-lite/commit/e7a658d3f5f7041ec87c43688165d8684817025a), [`d376d2c`](https://github.com/LTplus-AG/ifc-lite/commit/d376d2c02ff35ea25efca5983626fa0b8073bc90), [`f947f8e`](https://github.com/LTplus-AG/ifc-lite/commit/f947f8e92e23535fe4e6ba21c2ebd2a854540ce5), [`975c430`](https://github.com/LTplus-AG/ifc-lite/commit/975c43086065cc7eaaf841d18f6f5ecbe626f0bd), [`b218ab4`](https://github.com/LTplus-AG/ifc-lite/commit/b218ab440fc09011c6bb1d39524525120e119cb1), [`e095908`](https://github.com/LTplus-AG/ifc-lite/commit/e0959083fa58854ce536c0a68d7b0c52f824f5ef), [`d83d9fe`](https://github.com/LTplus-AG/ifc-lite/commit/d83d9fe4138e0d6ae64a3ed439c8a5c9a280878a), [`91b1340`](https://github.com/LTplus-AG/ifc-lite/commit/91b1340bbba42abc42d9842169e422b540aa96eb), [`dcdc8df`](https://github.com/LTplus-AG/ifc-lite/commit/dcdc8dff3ea9e0588ffcce802b0f3ec781082f2e), [`ccc491e`](https://github.com/LTplus-AG/ifc-lite/commit/ccc491efac18ce496af47c91b1ef4fc04ebecca5), [`7b1473c`](https://github.com/LTplus-AG/ifc-lite/commit/7b1473c316fc7c8f490ecd798cac80af9529d950), [`7215c2a`](https://github.com/LTplus-AG/ifc-lite/commit/7215c2a9344ede37c90680e1eb2a6c2b70c0ee3d), [`e6ebbef`](https://github.com/LTplus-AG/ifc-lite/commit/e6ebbefde52670adbdb0c35bc19baed0453ca42f), [`e40213f`](https://github.com/LTplus-AG/ifc-lite/commit/e40213f0806bf40fcbd1a93bce68fb7ad791bcef), [`a2e5d2d`](https://github.com/LTplus-AG/ifc-lite/commit/a2e5d2d9aa578efeb6d3becdc94335650b89f67d), [`5c02af8`](https://github.com/LTplus-AG/ifc-lite/commit/5c02af8b7fda4d2fe53f79d3f00b9d192fc664d9), [`356e151`](https://github.com/LTplus-AG/ifc-lite/commit/356e151813f37be4ceaf8699251be09c1149ffca), [`42b3f21`](https://github.com/LTplus-AG/ifc-lite/commit/42b3f214290d6c7d5fb27f697ec8451b323aabd4), [`a0e1bfe`](https://github.com/LTplus-AG/ifc-lite/commit/a0e1bfe567e3a892287faa8ee3e1b3610b59511d), [`11478f7`](https://github.com/LTplus-AG/ifc-lite/commit/11478f7b7e3b530a6111874bb233fada1a36d785), [`ddebcd9`](https://github.com/LTplus-AG/ifc-lite/commit/ddebcd91b999d6304e19358f90d142cd439a420a), [`40a58c9`](https://github.com/LTplus-AG/ifc-lite/commit/40a58c99afb968c02b8507ff1b5c394e4d107c50), [`cddb321`](https://github.com/LTplus-AG/ifc-lite/commit/cddb32122c9d628b635910158a06fa5a94c0071a), [`34750d2`](https://github.com/LTplus-AG/ifc-lite/commit/34750d20244f4151baf0b6d0b017513745914434), [`6bf4181`](https://github.com/LTplus-AG/ifc-lite/commit/6bf418103e872f13666037ae4868e03468e3840c), [`d2cfb9e`](https://github.com/LTplus-AG/ifc-lite/commit/d2cfb9e66affc2674d6de5da44ecdc5d8a76b59e), [`4c7bd47`](https://github.com/LTplus-AG/ifc-lite/commit/4c7bd47e5e8c9bf62d88af6260cc6384a77e0cdf), [`a3dfacb`](https://github.com/LTplus-AG/ifc-lite/commit/a3dfacb2862d1db09267ebe52707193630c35ff7), [`477c1d5`](https://github.com/LTplus-AG/ifc-lite/commit/477c1d5ef5bb5057ff12f9d074270ec2359b39e1), [`db7f991`](https://github.com/LTplus-AG/ifc-lite/commit/db7f991eb63998c65389a28e7331ac984a5448ad)]:
  - @ifc-lite/flow-nodes@0.4.0
  - @ifc-lite/bcf@4.2.1
  - @ifc-lite/clash@2.4.1
  - @ifc-lite/wasm@10.1.1
  - @ifc-lite/renderer@5.0.0
  - @ifc-lite/create@3.0.0
  - @ifc-lite/data@6.0.0
  - @ifc-lite/mcp@0.21.0
  - @ifc-lite/parser@9.0.0
  - @ifc-lite/rules@0.4.0
  - @ifc-lite/export@4.7.3
  - @ifc-lite/extensions@0.10.0
  - @ifc-lite/sandbox@2.7.0
  - @ifc-lite/flow@0.4.0
  - @ifc-lite/ids@3.0.3
  - @ifc-lite/mutations@2.7.1
  - @ifc-lite/sdk@7.1.2
  - @ifc-lite/cache@3.6.1
  - @ifc-lite/charts@0.6.1
  - @ifc-lite/collab@0.9.1
  - @ifc-lite/geometry@7.5.2
  - @ifc-lite/ifcx@4.2.1
  - @ifc-lite/lists@2.3.3
  - @ifc-lite/query@2.5.1

## 1.15.11

### Patch Changes

- Updated dependencies [[`90221d2`](https://github.com/LTplus-AG/ifc-lite/commit/90221d2f2928e8580050ddf9c26b5165f26af183), [`e682e6d`](https://github.com/LTplus-AG/ifc-lite/commit/e682e6da5f939aeca5940a65dd1cd338955e9c0f), [`5cfc6ff`](https://github.com/LTplus-AG/ifc-lite/commit/5cfc6ffd905db7fb512bddf1ddfa392c2156bd09), [`e48f59b`](https://github.com/LTplus-AG/ifc-lite/commit/e48f59b0cadf092335a84ce85b4d970e653b7d2c), [`aad1cbc`](https://github.com/LTplus-AG/ifc-lite/commit/aad1cbc6d88c020063f6483be6335bde6339568e), [`1909a6a`](https://github.com/LTplus-AG/ifc-lite/commit/1909a6ac6b9934c8793b6e6be8f80dfece3fd44e), [`df36858`](https://github.com/LTplus-AG/ifc-lite/commit/df368584163d44e0a76d54c4b50836091b07a2d2), [`0d25941`](https://github.com/LTplus-AG/ifc-lite/commit/0d25941ceadd2d5842bcd8a3d15fc21793ecfc63), [`00d6837`](https://github.com/LTplus-AG/ifc-lite/commit/00d68371ac6ab87fafa4bc5f0add2468a7e8a398), [`0200994`](https://github.com/LTplus-AG/ifc-lite/commit/02009943de1ca623b8f0f5bdc590ab6440689b98), [`262cb2e`](https://github.com/LTplus-AG/ifc-lite/commit/262cb2ea8049f5e64912624996f665eb5fce2ba3)]:
  - @ifc-lite/export@4.7.2
  - @ifc-lite/clash@2.4.0
  - @ifc-lite/wasm@10.1.0
  - @ifc-lite/create@2.9.2
  - @ifc-lite/renderer@4.2.0
  - @ifc-lite/extensions@0.9.0
  - @ifc-lite/sdk@7.1.1
  - @ifc-lite/mcp@0.20.2
  - @ifc-lite/data@5.3.0
  - @ifc-lite/server-client@3.2.0
  - @ifc-lite/flow-nodes@0.3.1
  - @ifc-lite/ids@3.0.2
  - @ifc-lite/lists@2.3.2
  - @ifc-lite/rules@0.3.2

## 1.15.10

### Patch Changes

- Updated dependencies [[`2523acc`](https://github.com/LTplus-AG/ifc-lite/commit/2523acc5881252316439de2f69f7fab4266d559f), [`5909977`](https://github.com/LTplus-AG/ifc-lite/commit/5909977e0631cc242c421b5ded6c887acadd92ba), [`b12b113`](https://github.com/LTplus-AG/ifc-lite/commit/b12b11325a47f1989c855f6e12c1f243da10ef9a), [`3edd57d`](https://github.com/LTplus-AG/ifc-lite/commit/3edd57d9bf0b4fddb28da3401bc5cf0189756729), [`77f5e16`](https://github.com/LTplus-AG/ifc-lite/commit/77f5e16e939aac5d28301c56a29c04472aa90792), [`610c3a1`](https://github.com/LTplus-AG/ifc-lite/commit/610c3a1d60c76850c2d2cc839e176f97ec0e2ca6), [`35b8b23`](https://github.com/LTplus-AG/ifc-lite/commit/35b8b238821138d6c5bc94d3ad51abf832677a88), [`8d45322`](https://github.com/LTplus-AG/ifc-lite/commit/8d45322f544ba1c3a6352303dfb048cc5d3836a6), [`dec98a2`](https://github.com/LTplus-AG/ifc-lite/commit/dec98a2c97e03e70e8b78c55bb27e87b5b4013a6), [`5e79d7e`](https://github.com/LTplus-AG/ifc-lite/commit/5e79d7eb6837e238060dde19fa0b4933b832c1a7), [`83284a9`](https://github.com/LTplus-AG/ifc-lite/commit/83284a947d9adb9e1ece28f9d5ee7166722be1e5), [`992f553`](https://github.com/LTplus-AG/ifc-lite/commit/992f55304ca0ec8ed5be3b4eabab429c68808a7e), [`8fe905e`](https://github.com/LTplus-AG/ifc-lite/commit/8fe905ed4ee6db585da82e6eb15b1b117d45c86b), [`aaaa9c6`](https://github.com/LTplus-AG/ifc-lite/commit/aaaa9c65de99ee25cdd95a34a0c234405576e8bd), [`e8e5813`](https://github.com/LTplus-AG/ifc-lite/commit/e8e58133abd2bd1a6a1f42bc3f8f6c9df828464a), [`bc22259`](https://github.com/LTplus-AG/ifc-lite/commit/bc222597e04bfa46d8fc331913615ec72d25bc64), [`32ac1f9`](https://github.com/LTplus-AG/ifc-lite/commit/32ac1f9846a5703c63ea859e5aeaf224f164db0c), [`0ddc31a`](https://github.com/LTplus-AG/ifc-lite/commit/0ddc31a0d4f321e4f4f43dd3e95572972c7937bb), [`c8fcbfb`](https://github.com/LTplus-AG/ifc-lite/commit/c8fcbfbfcc8e45526ef93c84ee8a254df586c10b), [`45ddd91`](https://github.com/LTplus-AG/ifc-lite/commit/45ddd91d1cee1c261ca5f1b1d0087fb2e070690f), [`7bab13a`](https://github.com/LTplus-AG/ifc-lite/commit/7bab13af06b8d8778f6cdb513ad299e760e55074), [`809e2ba`](https://github.com/LTplus-AG/ifc-lite/commit/809e2baa4b796a91ea2a2dbd52ae29e7dd4ef5ff), [`d8f7c64`](https://github.com/LTplus-AG/ifc-lite/commit/d8f7c643703012c55a41a1e8224db6e21a0c66b3), [`e66c849`](https://github.com/LTplus-AG/ifc-lite/commit/e66c849b6a79de9691a1e70ee3b2b593c5327fa1), [`51cb84d`](https://github.com/LTplus-AG/ifc-lite/commit/51cb84d29c5d6add21d94ffd9947f7c6884f5b39), [`eb8c3d6`](https://github.com/LTplus-AG/ifc-lite/commit/eb8c3d66a8a9091aecb947ceeb2b2dcae189d533), [`c0f6caa`](https://github.com/LTplus-AG/ifc-lite/commit/c0f6caab3c726369707173e8aa48017a609e7cc0), [`52d30de`](https://github.com/LTplus-AG/ifc-lite/commit/52d30de0ae3fc8ef6322191bd1831483b93d485f), [`a250a92`](https://github.com/LTplus-AG/ifc-lite/commit/a250a928b1c8c64ac6153136772fe6c71398eee9), [`b8a9cde`](https://github.com/LTplus-AG/ifc-lite/commit/b8a9cde0a7dfe40137632bf083875961efb57c1a), [`617da29`](https://github.com/LTplus-AG/ifc-lite/commit/617da29bc17326105dd1143385c967210e529a43), [`73c0c5d`](https://github.com/LTplus-AG/ifc-lite/commit/73c0c5de3981987d6672de19cef2c64d61259277), [`074178f`](https://github.com/LTplus-AG/ifc-lite/commit/074178f651c21dacbfbec33534701a59a7e81ace), [`dabc489`](https://github.com/LTplus-AG/ifc-lite/commit/dabc48987aca1392685218dd31641f8dbadf9590), [`dabc489`](https://github.com/LTplus-AG/ifc-lite/commit/dabc48987aca1392685218dd31641f8dbadf9590), [`60f70f9`](https://github.com/LTplus-AG/ifc-lite/commit/60f70f93c9cdf9948f1a7325efb1e157a09d3a60), [`bd15b3f`](https://github.com/LTplus-AG/ifc-lite/commit/bd15b3f607f43ab47c8f4d530ed95231f802e15c), [`eebb00e`](https://github.com/LTplus-AG/ifc-lite/commit/eebb00e52719e0254d1626f791740ce7fe7489a9), [`94324e2`](https://github.com/LTplus-AG/ifc-lite/commit/94324e2a69a6cf41cf23488ccdc56b2b7d2c069f), [`2dd677d`](https://github.com/LTplus-AG/ifc-lite/commit/2dd677d7307d87f3b433256bd00647a2a3ee06df), [`46f79e3`](https://github.com/LTplus-AG/ifc-lite/commit/46f79e38649c6d78753587aeaefbf3d5bbef0d95), [`7ac41e9`](https://github.com/LTplus-AG/ifc-lite/commit/7ac41e9c1899763be20d4f7fa501f8b9f955ec96), [`6198d55`](https://github.com/LTplus-AG/ifc-lite/commit/6198d55d1fd38e02c91e48bf689ab9127fbdf2f8), [`7e5eb9e`](https://github.com/LTplus-AG/ifc-lite/commit/7e5eb9eb9631bceeefd5f03e6c18ac4cc7e35876), [`29688df`](https://github.com/LTplus-AG/ifc-lite/commit/29688df238998baea77b3fe55afe113b40c13eae), [`8327d5f`](https://github.com/LTplus-AG/ifc-lite/commit/8327d5f6a6775df9692e7618a1d02707639eb54e), [`d6f65a0`](https://github.com/LTplus-AG/ifc-lite/commit/d6f65a009b72bef2f11c65e2b577b4d621abd0eb), [`4041f2f`](https://github.com/LTplus-AG/ifc-lite/commit/4041f2f75ae136a400e11de5c546bb136e97e8ef), [`a341dc9`](https://github.com/LTplus-AG/ifc-lite/commit/a341dc9512531a353c12d264b806a527d8de63f6), [`b9206c9`](https://github.com/LTplus-AG/ifc-lite/commit/b9206c94dceef0041dcf37e4cfe44cf09f4b4d7b), [`70ad6a7`](https://github.com/LTplus-AG/ifc-lite/commit/70ad6a7c77b73d6a04a7d842a64ce4a014451e68), [`52d30de`](https://github.com/LTplus-AG/ifc-lite/commit/52d30de0ae3fc8ef6322191bd1831483b93d485f), [`3166183`](https://github.com/LTplus-AG/ifc-lite/commit/31661831c8137f31aa6c3b0da286832ed6e16a7b), [`1c12066`](https://github.com/LTplus-AG/ifc-lite/commit/1c12066f096f52389277b5fce738fc7e03a5334d), [`f942fb6`](https://github.com/LTplus-AG/ifc-lite/commit/f942fb6c48ac9be1464e49fd963340835a72945d), [`08f3eca`](https://github.com/LTplus-AG/ifc-lite/commit/08f3eca2222a244402d07e30f7aaab8633967bb5), [`79716f9`](https://github.com/LTplus-AG/ifc-lite/commit/79716f9828e4f57bedeaef66292233806b15edf7), [`d05f542`](https://github.com/LTplus-AG/ifc-lite/commit/d05f5423a7caf761f0a2e12d064d85e84355d031), [`87d62bc`](https://github.com/LTplus-AG/ifc-lite/commit/87d62bca61704029b92882f2dd280dd497a77bd7), [`9132f7a`](https://github.com/LTplus-AG/ifc-lite/commit/9132f7ab81939eb145e8fe1b26eb1e9048321638), [`be636b4`](https://github.com/LTplus-AG/ifc-lite/commit/be636b414c11e7c5b77c2b98d0e916822ac39d09), [`58691b3`](https://github.com/LTplus-AG/ifc-lite/commit/58691b362d67ab87f666d76d6ee27e39d1ec45f9), [`b1004c3`](https://github.com/LTplus-AG/ifc-lite/commit/b1004c3f0fe070d01dd7fc8b8d889c3dd990c14b), [`610d7f2`](https://github.com/LTplus-AG/ifc-lite/commit/610d7f29708bb4febf7dd9a8d716a8e5e0b4dba4), [`5665917`](https://github.com/LTplus-AG/ifc-lite/commit/566591746eead289fcc5aa60258ef96b30366456), [`9f7dddb`](https://github.com/LTplus-AG/ifc-lite/commit/9f7dddb8ac649de09b271856ec3ba826fa034f56), [`80c6a38`](https://github.com/LTplus-AG/ifc-lite/commit/80c6a38a3efc8783965e94d309bcc2f984cef71d), [`253cc3e`](https://github.com/LTplus-AG/ifc-lite/commit/253cc3e96ff001b3514f182a61b1be70f6a89fa5), [`253cc3e`](https://github.com/LTplus-AG/ifc-lite/commit/253cc3e96ff001b3514f182a61b1be70f6a89fa5), [`82fffa3`](https://github.com/LTplus-AG/ifc-lite/commit/82fffa36637e14c9457b631e3e9aa9599c410c5b), [`2dd677d`](https://github.com/LTplus-AG/ifc-lite/commit/2dd677d7307d87f3b433256bd00647a2a3ee06df), [`94bd946`](https://github.com/LTplus-AG/ifc-lite/commit/94bd946d7a4e9ab98c5e9a950fa6e8a8e39b5316), [`2dd677d`](https://github.com/LTplus-AG/ifc-lite/commit/2dd677d7307d87f3b433256bd00647a2a3ee06df), [`becc9dc`](https://github.com/LTplus-AG/ifc-lite/commit/becc9dc4bd33267dbe8522f788fb8936dd349b70), [`24b7921`](https://github.com/LTplus-AG/ifc-lite/commit/24b79210c442f44614d5786ff2986ee3a2b9c0d7), [`0d9cbc0`](https://github.com/LTplus-AG/ifc-lite/commit/0d9cbc0072baa634923623c6772500d57a63f412), [`3f0af07`](https://github.com/LTplus-AG/ifc-lite/commit/3f0af07966ecd8493b83315b81a0cdf2c9889d66), [`685b541`](https://github.com/LTplus-AG/ifc-lite/commit/685b5414f57eec64c74e056b9b51b6b8ffe3a88f), [`337aab4`](https://github.com/LTplus-AG/ifc-lite/commit/337aab4f4f7dbb37834502414eac69561ccae932), [`71ace41`](https://github.com/LTplus-AG/ifc-lite/commit/71ace41b0ccfde286fe7fc1074011a91c9c8d5b1), [`049d987`](https://github.com/LTplus-AG/ifc-lite/commit/049d9873ebb4a1f312ea0e8f8bef4c55460d3d23), [`7e8d225`](https://github.com/LTplus-AG/ifc-lite/commit/7e8d225273d3f20d727dac879e31ac4e6ce165bb), [`fc6f49c`](https://github.com/LTplus-AG/ifc-lite/commit/fc6f49c79485640073b924df86a0973c691b7a5f), [`6314cbe`](https://github.com/LTplus-AG/ifc-lite/commit/6314cbed245efb39552487307be55b6884fd0b97), [`fbda35b`](https://github.com/LTplus-AG/ifc-lite/commit/fbda35b5bbf5475fe99d85301aff728624058f8d), [`e6f46cb`](https://github.com/LTplus-AG/ifc-lite/commit/e6f46cbaf7d2ea515296f40497556b2b31bc5bd2), [`f66adb5`](https://github.com/LTplus-AG/ifc-lite/commit/f66adb5fa9a35bf4ae4a9a9e9f36e477f815ad35), [`76d1119`](https://github.com/LTplus-AG/ifc-lite/commit/76d1119fb1573ef81f50d03c04026be3c83674ce), [`decff6b`](https://github.com/LTplus-AG/ifc-lite/commit/decff6bc31589df65bdd8dd20e72a0b840a4be7a), [`affda87`](https://github.com/LTplus-AG/ifc-lite/commit/affda87e1b892b608d5790387a3ab3315d47ae8c), [`316c0bf`](https://github.com/LTplus-AG/ifc-lite/commit/316c0bf248ca2573cc63acf421e4ccba4c7638c7), [`24b7921`](https://github.com/LTplus-AG/ifc-lite/commit/24b79210c442f44614d5786ff2986ee3a2b9c0d7), [`07ed0dd`](https://github.com/LTplus-AG/ifc-lite/commit/07ed0ddaf4e527f1fff3704cc0d36e700fcde1a7), [`b0f3b80`](https://github.com/LTplus-AG/ifc-lite/commit/b0f3b803d70442307b6741b78b85adef976e6f63), [`a1a7f32`](https://github.com/LTplus-AG/ifc-lite/commit/a1a7f32bc5ecb9a9aed9432c575afa5191791737), [`1d71f36`](https://github.com/LTplus-AG/ifc-lite/commit/1d71f366e11043a80fa81055323b5118d84d213e), [`0d9cbc0`](https://github.com/LTplus-AG/ifc-lite/commit/0d9cbc0072baa634923623c6772500d57a63f412), [`9f48e65`](https://github.com/LTplus-AG/ifc-lite/commit/9f48e653f8264d303f70f47370be727ebca6049a), [`897eb6c`](https://github.com/LTplus-AG/ifc-lite/commit/897eb6c15342ad20a032b40fcb803559bf1a10f7), [`2e13572`](https://github.com/LTplus-AG/ifc-lite/commit/2e135720996f3a3d48ec830f6895ac304f69e5dd), [`621de01`](https://github.com/LTplus-AG/ifc-lite/commit/621de015a52e65493fcda331ccaf9ffcfb626a47), [`80c6a38`](https://github.com/LTplus-AG/ifc-lite/commit/80c6a38a3efc8783965e94d309bcc2f984cef71d), [`18b082f`](https://github.com/LTplus-AG/ifc-lite/commit/18b082ff95eedf847d29108726d4fee63c93057e), [`177f6d1`](https://github.com/LTplus-AG/ifc-lite/commit/177f6d18decd296ab6c25e7ec1d8200e461ceda0), [`4175a1e`](https://github.com/LTplus-AG/ifc-lite/commit/4175a1e0e8b055de2a5c58288a87b84c3c85c610), [`18650b0`](https://github.com/LTplus-AG/ifc-lite/commit/18650b0c67973833f675c6b8128ab55250a47efd)]:
  - @ifc-lite/wasm@10.0.0
  - @ifc-lite/renderer@4.1.0
  - @ifc-lite/bcf-api@0.2.3
  - @ifc-lite/bcf@4.2.0
  - @ifc-lite/mutations@2.7.0
  - @ifc-lite/geometry@7.5.1
  - @ifc-lite/collab@0.9.0
  - @ifc-lite/spatial@1.15.0
  - @ifc-lite/data@5.1.0
  - @ifc-lite/charts@0.6.0
  - @ifc-lite/clash@2.3.2
  - @ifc-lite/parser@8.1.0
  - @ifc-lite/ids@3.0.0
  - @ifc-lite/export@4.7.0
  - @ifc-lite/create@2.9.0
  - @ifc-lite/flow-nodes@0.3.0
  - @ifc-lite/pointcloud@0.11.0
  - @ifc-lite/mcp@0.20.0
  - @ifc-lite/ifcx@4.2.0
  - @ifc-lite/server-client@3.1.0
  - @ifc-lite/flow@0.3.0
  - @ifc-lite/rules@0.3.0
  - @ifc-lite/plugin-api@0.3.1
  - @ifc-lite/lists@2.3.0
  - @ifc-lite/sdk@7.1.0
  - @ifc-lite/diff@0.10.0
  - @ifc-lite/merge@0.4.7

## 1.15.9

### Patch Changes

- [#5124](https://github.com/LTplus-AG/ifc-lite/pull/5124) [`65d088e`](https://github.com/LTplus-AG/ifc-lite/commit/65d088e3aa7dddc4f27eacf133b4ded33c7aed5d) Thanks [@louistrue](https://github.com/louistrue)! - Expose resident point-cloud visibility control so viewer model visibility also
  excludes streamed scans from drawing, framing, and point picking.
- Updated dependencies [[`b785770`](https://github.com/LTplus-AG/ifc-lite/commit/b7857709a31f958601f1c4c9af09e5a95f81300e), [`a11c090`](https://github.com/LTplus-AG/ifc-lite/commit/a11c090d0c86a9241bb67ce42822be5b6a631196), [`bb17a78`](https://github.com/LTplus-AG/ifc-lite/commit/bb17a78703ee090969136613fd64103dbf30d218), [`51c36ec`](https://github.com/LTplus-AG/ifc-lite/commit/51c36ecd9051769be7762d711bff705ef76866aa), [`3b0c496`](https://github.com/LTplus-AG/ifc-lite/commit/3b0c496bc2789c56812bfce40021e2beb2eb830e), [`9739441`](https://github.com/LTplus-AG/ifc-lite/commit/9739441c1d0bd36c92bd492013c141b8a8f4a990), [`0eafae1`](https://github.com/LTplus-AG/ifc-lite/commit/0eafae1cb19e70828815c658a6ee3c14f9c4c8a8), [`f87bed2`](https://github.com/LTplus-AG/ifc-lite/commit/f87bed29a52610b66b3d0ee510406ce087a66621), [`04b5467`](https://github.com/LTplus-AG/ifc-lite/commit/04b54673aa1a888ebf8f5d2f48b27558d3e6c4f0), [`0ee73f7`](https://github.com/LTplus-AG/ifc-lite/commit/0ee73f70b0aa08c811e37fe3b2c20fe176d3d8f1), [`0ee73f7`](https://github.com/LTplus-AG/ifc-lite/commit/0ee73f70b0aa08c811e37fe3b2c20fe176d3d8f1), [`bef4149`](https://github.com/LTplus-AG/ifc-lite/commit/bef41495ccdcf1dbc8e5024f633c74b44ccef137), [`04ef10f`](https://github.com/LTplus-AG/ifc-lite/commit/04ef10fef50f8e53e96430741afc27a69ebff906), [`3eaf48c`](https://github.com/LTplus-AG/ifc-lite/commit/3eaf48cd8cf10ee117be4086f78224a21e4960c8), [`9b910f4`](https://github.com/LTplus-AG/ifc-lite/commit/9b910f4ad0a187addead0f578b81e332287f0ea3), [`30984b4`](https://github.com/LTplus-AG/ifc-lite/commit/30984b4abecb838c132e5823ad51455a6ee0c15a), [`bde27c5`](https://github.com/LTplus-AG/ifc-lite/commit/bde27c581e242f8479147e865b17a5ff6a0dc436), [`b6ac473`](https://github.com/LTplus-AG/ifc-lite/commit/b6ac4730babff9ba78fa06bae8f98c14958c0cea), [`b9d0ff6`](https://github.com/LTplus-AG/ifc-lite/commit/b9d0ff6eab8dca015497c6e8e0598b81ee81a43d), [`b9d0ff6`](https://github.com/LTplus-AG/ifc-lite/commit/b9d0ff6eab8dca015497c6e8e0598b81ee81a43d), [`86ffd75`](https://github.com/LTplus-AG/ifc-lite/commit/86ffd751cc783dfc4ee7a9b55508d5c75b844178), [`829b566`](https://github.com/LTplus-AG/ifc-lite/commit/829b566988aabe0ed3676b7df6082d3169df8830), [`18833c8`](https://github.com/LTplus-AG/ifc-lite/commit/18833c86af7d8ff9699970c4440d90b2235ef2f7), [`8356b8e`](https://github.com/LTplus-AG/ifc-lite/commit/8356b8ea43968a291cb8117736bf8cb4e9c4cdfa), [`35e54fc`](https://github.com/LTplus-AG/ifc-lite/commit/35e54fc20bc8a7632b9caec26cdb820e1ee0c0b7), [`35e54fc`](https://github.com/LTplus-AG/ifc-lite/commit/35e54fc20bc8a7632b9caec26cdb820e1ee0c0b7), [`1a0971c`](https://github.com/LTplus-AG/ifc-lite/commit/1a0971c1f75ad9af1845aa67987532f85ac2dccb), [`f2d9c78`](https://github.com/LTplus-AG/ifc-lite/commit/f2d9c78b2b72264493847adea03ee80167e42242), [`a2d99b7`](https://github.com/LTplus-AG/ifc-lite/commit/a2d99b7ead4e07c11000ea3392e9a1f43d91ded6), [`06a336d`](https://github.com/LTplus-AG/ifc-lite/commit/06a336d512fc4470cb7372b33a5f8eea2aa1c070), [`816114a`](https://github.com/LTplus-AG/ifc-lite/commit/816114ad21120e3bd84394e080c44e6679ae959d), [`0eafae1`](https://github.com/LTplus-AG/ifc-lite/commit/0eafae1cb19e70828815c658a6ee3c14f9c4c8a8), [`3a2b62f`](https://github.com/LTplus-AG/ifc-lite/commit/3a2b62f2d36bfb740c3551e86e8641d7e8f596b5), [`3be90af`](https://github.com/LTplus-AG/ifc-lite/commit/3be90af6fa5b0446f6077ddff92873f68b58a7c0), [`b0d489e`](https://github.com/LTplus-AG/ifc-lite/commit/b0d489ea7270b84c1d373b5e340fc09ba0c798e6), [`65d088e`](https://github.com/LTplus-AG/ifc-lite/commit/65d088e3aa7dddc4f27eacf133b4ded33c7aed5d)]:
  - @ifc-lite/charts@0.5.0
  - @ifc-lite/wasm@9.3.0
  - @ifc-lite/server-client@3.0.1
  - @ifc-lite/mcp@0.19.0
  - @ifc-lite/cache@3.6.0
  - @ifc-lite/create@2.8.0
  - @ifc-lite/sdk@7.0.0
  - @ifc-lite/mutations@2.6.0
  - @ifc-lite/flow@0.2.0
  - @ifc-lite/flow-nodes@0.2.0
  - @ifc-lite/ids@2.0.0
  - @ifc-lite/renderer@4.0.0
  - @ifc-lite/export@4.6.0
  - @ifc-lite/geometry@7.5.0
  - @ifc-lite/pointcloud@0.10.0
  - @ifc-lite/rules@0.2.0
  - @ifc-lite/sandbox@2.6.1
  - @ifc-lite/ifcx@4.1.3

## 1.15.8

### Patch Changes

- Updated dependencies [[`faadbb4`](https://github.com/LTplus-AG/ifc-lite/commit/faadbb409bc67bb5ace32757db050dd0ed83814f), [`873a648`](https://github.com/LTplus-AG/ifc-lite/commit/873a6481af34f1a494e9667ab1f77c3328125077), [`873a648`](https://github.com/LTplus-AG/ifc-lite/commit/873a6481af34f1a494e9667ab1f77c3328125077), [`7556ce5`](https://github.com/LTplus-AG/ifc-lite/commit/7556ce5bb330ae37d089226f28e5c3049346c0a7), [`531246a`](https://github.com/LTplus-AG/ifc-lite/commit/531246a1a9f53ea6b66f7f1d140c7df268adc242), [`d38af5a`](https://github.com/LTplus-AG/ifc-lite/commit/d38af5afd36f12329fe6f33bf905d28fca65ba43), [`b399a49`](https://github.com/LTplus-AG/ifc-lite/commit/b399a49cbccc0456eae50cc50521674336632d1a), [`0100a54`](https://github.com/LTplus-AG/ifc-lite/commit/0100a544d0446d2f19b5f76f37d6dc45d31da837), [`55d4354`](https://github.com/LTplus-AG/ifc-lite/commit/55d43541c7dfce6006d391a5034169ea54014d5f), [`dce19f5`](https://github.com/LTplus-AG/ifc-lite/commit/dce19f57399b9e75901fa5c4283adf781681301e), [`0e8a421`](https://github.com/LTplus-AG/ifc-lite/commit/0e8a4217514dcfacc7c488a230de244288428e1b), [`86dafce`](https://github.com/LTplus-AG/ifc-lite/commit/86dafced6e166889514a8514a23419659d0e7ce6), [`55d4354`](https://github.com/LTplus-AG/ifc-lite/commit/55d43541c7dfce6006d391a5034169ea54014d5f), [`1e2e444`](https://github.com/LTplus-AG/ifc-lite/commit/1e2e444a4991b16a448355ac6b494da42339ffd0), [`e9c6eb9`](https://github.com/LTplus-AG/ifc-lite/commit/e9c6eb9a8385629a05219e682650a4289b7be0fa), [`e2ca87d`](https://github.com/LTplus-AG/ifc-lite/commit/e2ca87d9b8f25be2ffeabd5843cbadc4154471c0), [`c230e9a`](https://github.com/LTplus-AG/ifc-lite/commit/c230e9a40b5d56a4e1149f3c7f14bac71cd19de7), [`e1ace4f`](https://github.com/LTplus-AG/ifc-lite/commit/e1ace4f05a45a252d502bf72a506336185d2b157), [`9c41278`](https://github.com/LTplus-AG/ifc-lite/commit/9c412786c4fa21f4ace497e7408bad7d742bdf24), [`ab8380e`](https://github.com/LTplus-AG/ifc-lite/commit/ab8380e6b9edf1ca1f05abf343ae6040ac8aee77), [`bab4e30`](https://github.com/LTplus-AG/ifc-lite/commit/bab4e30f438ac0bb585ea00a62a1a98a8221bede), [`427e886`](https://github.com/LTplus-AG/ifc-lite/commit/427e88664b021125bc7f9c07fe1f57f209410ad6), [`794986e`](https://github.com/LTplus-AG/ifc-lite/commit/794986e8fa5acec057429b49302274ac8046eefe), [`6a5f3f2`](https://github.com/LTplus-AG/ifc-lite/commit/6a5f3f2ae703ce170b890f85535af846251d3ab7), [`24b2416`](https://github.com/LTplus-AG/ifc-lite/commit/24b24167e7213ed8f8c8d92211ec38c7221b9a11), [`65ea107`](https://github.com/LTplus-AG/ifc-lite/commit/65ea107b83e3d543b410721c74195562ca50bcca), [`47f39b8`](https://github.com/LTplus-AG/ifc-lite/commit/47f39b850e2a1d0ebb2fd8654839f917620f3542), [`0a62c19`](https://github.com/LTplus-AG/ifc-lite/commit/0a62c196a05fb47fc2bf6c0c083ea32ed20dd1d8), [`873a648`](https://github.com/LTplus-AG/ifc-lite/commit/873a6481af34f1a494e9667ab1f77c3328125077), [`ec114fe`](https://github.com/LTplus-AG/ifc-lite/commit/ec114fefabfd1b3a23d6a25545610652db6c5342), [`bcff7f6`](https://github.com/LTplus-AG/ifc-lite/commit/bcff7f669b26dfb5b89865e8c6e3db83cc01aa74), [`6e28171`](https://github.com/LTplus-AG/ifc-lite/commit/6e28171ea15c1b9863e617b729921a38ac6c55d9), [`bd1e3f1`](https://github.com/LTplus-AG/ifc-lite/commit/bd1e3f109c403e0a072f8c5cb561f8bab54cb1d7), [`62a57f7`](https://github.com/LTplus-AG/ifc-lite/commit/62a57f7e991202500b2e9c3d553376f9c45fd2c5), [`19af4c9`](https://github.com/LTplus-AG/ifc-lite/commit/19af4c9b5529a9052daf8a023ebe4e5144b9db2f), [`6e283f0`](https://github.com/LTplus-AG/ifc-lite/commit/6e283f0fb187195aae76097dd4ee1660a20ae325), [`e30b86c`](https://github.com/LTplus-AG/ifc-lite/commit/e30b86cacf142c64a3bdbf310861ac7bf12a3f1b), [`3a47a0c`](https://github.com/LTplus-AG/ifc-lite/commit/3a47a0c2bb70966741882f8a0bae996823b9881f), [`e211790`](https://github.com/LTplus-AG/ifc-lite/commit/e211790ff4d7070d908fb519652158089652dd9c), [`50c23d4`](https://github.com/LTplus-AG/ifc-lite/commit/50c23d4321252a2fafff41e085e64e351c2cdb31), [`fc72af0`](https://github.com/LTplus-AG/ifc-lite/commit/fc72af07fab21f0359002346ae5be60e085b8a41)]:
  - @ifc-lite/wasm@9.2.0
  - @ifc-lite/query@2.5.0
  - @ifc-lite/charts@0.4.0
  - @ifc-lite/mcp@0.18.0
  - @ifc-lite/data@5.0.0
  - @ifc-lite/parser@8.0.0
  - @ifc-lite/sdk@6.4.0
  - @ifc-lite/cache@3.5.1
  - @ifc-lite/extensions@0.8.0
  - @ifc-lite/export@4.5.0
  - @ifc-lite/create@2.7.0
  - @ifc-lite/mutations@2.5.0
  - @ifc-lite/sandbox@2.6.0
  - @ifc-lite/renderer@3.2.0
  - @ifc-lite/geometry@7.4.0
  - @ifc-lite/diff@0.9.0
  - @ifc-lite/collab@0.8.1
  - @ifc-lite/ids@1.17.4
  - @ifc-lite/ifcx@4.1.2
  - @ifc-lite/lists@2.2.5
  - @ifc-lite/clash@2.3.1
  - @ifc-lite/merge@0.4.6

## 1.15.7

### Patch Changes

- [#4914](https://github.com/LTplus-AG/ifc-lite/pull/4914) [`8ed7798`](https://github.com/LTplus-AG/ifc-lite/commit/8ed77988bff92c696a3351f67c6e2ea013917b17) Thanks [@louistrue](https://github.com/louistrue)! - The section cut state now matches what the 3D view shows. Leaving the Section tool hides the cut, and the viewer no longer reports it as active: `bim.viewer.getSection()` returns `null` and the view PDF export prints no cut. Reopening the Section tool brings the cut back, face-picked planes included. `bim.viewer.setSection({ enabled: true })` and applying a BCF viewpoint with clipping planes open the Section tool so the cut is visible. Applying a viewpoint without clipping planes, or `bim.viewer.clearSection()`, clears the cut, and it stays cleared when the Section tool reopens. The embed `SET_SECTION` command with `enabled: true` now shows the cut too.
- Updated dependencies [[`cd4ee9e`](https://github.com/LTplus-AG/ifc-lite/commit/cd4ee9e6ddb7089babde6e6e38c3dc0877e95b16), [`bbd3a67`](https://github.com/LTplus-AG/ifc-lite/commit/bbd3a675dbccb75e0f7c9df80c2a65a831478adf), [`9f34896`](https://github.com/LTplus-AG/ifc-lite/commit/9f34896cc7c8e19ce9a75367aa8b4cfa23877944), [`bbd3a67`](https://github.com/LTplus-AG/ifc-lite/commit/bbd3a675dbccb75e0f7c9df80c2a65a831478adf), [`ef42c0e`](https://github.com/LTplus-AG/ifc-lite/commit/ef42c0edeb4081e0ad9318c3a0f32301a30e6936), [`8ccfa05`](https://github.com/LTplus-AG/ifc-lite/commit/8ccfa0573331dc2ecc602b74945f8cc54229829b), [`603d987`](https://github.com/LTplus-AG/ifc-lite/commit/603d9872bef5d340cccfc76fe0708f2feaafad49), [`076428b`](https://github.com/LTplus-AG/ifc-lite/commit/076428b45a71292f226462577753085f7d23ba64), [`39153d1`](https://github.com/LTplus-AG/ifc-lite/commit/39153d155e8c0a5620cdc1802837d6e0f9e7619b), [`6a9fc13`](https://github.com/LTplus-AG/ifc-lite/commit/6a9fc132731132bbbec2d9241242ae99e063a27e), [`1606952`](https://github.com/LTplus-AG/ifc-lite/commit/16069523591defe5650b794acebf66e373f4cdb2), [`37a5949`](https://github.com/LTplus-AG/ifc-lite/commit/37a5949b1ed3786b52602b62d04bf1ac451844b3), [`84941dd`](https://github.com/LTplus-AG/ifc-lite/commit/84941dd8413a153040714968dcd684a610334c9a), [`f24aff9`](https://github.com/LTplus-AG/ifc-lite/commit/f24aff9a7f7685af2cdf0230fe4c712d7dc37940)]:
  - @ifc-lite/charts@0.3.0
  - @ifc-lite/parser@7.1.0
  - @ifc-lite/sdk@6.3.0
  - @ifc-lite/export@4.4.0
  - @ifc-lite/geometry@7.3.0
  - @ifc-lite/renderer@3.1.0
  - @ifc-lite/data@4.5.0
  - @ifc-lite/mutations@2.4.0
  - @ifc-lite/query@2.4.2
  - @ifc-lite/ids@1.17.3
  - @ifc-lite/lists@2.2.4

## 1.15.6

### Patch Changes

- Updated dependencies [[`1cc533f`](https://github.com/LTplus-AG/ifc-lite/commit/1cc533f5ca326a8d574ca5e870dfdafec7df32d0), [`35c0517`](https://github.com/LTplus-AG/ifc-lite/commit/35c0517d9779297704979131f451a4ae704bf744), [`e43c455`](https://github.com/LTplus-AG/ifc-lite/commit/e43c455711d4070b530436413db948fedcc34053), [`8733dc9`](https://github.com/LTplus-AG/ifc-lite/commit/8733dc9cb391344606b9bc59beb00a6f9d1de135), [`20bff7c`](https://github.com/LTplus-AG/ifc-lite/commit/20bff7c4069d267aa2662266b6213c3b2b406753)]:
  - @ifc-lite/bcf@4.1.0
  - @ifc-lite/clash@2.3.0
  - @ifc-lite/geometry@7.2.0
  - @ifc-lite/sdk@6.2.0
  - @ifc-lite/mcp@0.17.0
  - @ifc-lite/sandbox@2.5.0
  - @ifc-lite/parser@7.0.0
  - @ifc-lite/create@2.6.0
  - @ifc-lite/export@4.3.5
  - @ifc-lite/ids@1.17.2
  - @ifc-lite/query@2.4.1

## 1.15.5

### Patch Changes

- Updated dependencies [[`0635737`](https://github.com/LTplus-AG/ifc-lite/commit/06357376a7badddf9359e0663999964948504e6e), [`e8e319f`](https://github.com/LTplus-AG/ifc-lite/commit/e8e319ff76e4dac5e0d0de3cc0a00b4d9f3c8e76), [`7b34e97`](https://github.com/LTplus-AG/ifc-lite/commit/7b34e97f2abdc49be3eef78031d52d1107622544), [`5bd1d89`](https://github.com/LTplus-AG/ifc-lite/commit/5bd1d8905e461815e8749b4c893e67b11a746e53), [`6fa3d14`](https://github.com/LTplus-AG/ifc-lite/commit/6fa3d1425a822c5dcc3f0e811b809791eea163da), [`b1f9519`](https://github.com/LTplus-AG/ifc-lite/commit/b1f95194150893d56b6955273cd540fccf2b16be), [`be17583`](https://github.com/LTplus-AG/ifc-lite/commit/be175830fb938af4dde6c1f6990b1faa194c8771), [`f55d749`](https://github.com/LTplus-AG/ifc-lite/commit/f55d7492893406a59d86a6cba4b41a80aa2589d9), [`7b34e97`](https://github.com/LTplus-AG/ifc-lite/commit/7b34e97f2abdc49be3eef78031d52d1107622544), [`d342909`](https://github.com/LTplus-AG/ifc-lite/commit/d3429093f06cb8f5405ac9792ec2aadbcf69f140), [`7b34e97`](https://github.com/LTplus-AG/ifc-lite/commit/7b34e97f2abdc49be3eef78031d52d1107622544), [`36fa88e`](https://github.com/LTplus-AG/ifc-lite/commit/36fa88e8862416ac6a9f493135c6fdfca793d0eb)]:
  - @ifc-lite/wasm@9.0.1
  - @ifc-lite/export@4.3.3
  - @ifc-lite/mcp@0.16.0
  - @ifc-lite/server-client@3.0.0
  - @ifc-lite/query@2.4.0
  - @ifc-lite/geometry@7.0.1
  - @ifc-lite/sdk@6.0.0
  - @ifc-lite/ids@1.17.0
  - @ifc-lite/sandbox@2.3.1

## 1.15.4

### Patch Changes

- Updated dependencies [[`d03e3ce`](https://github.com/LTplus-AG/ifc-lite/commit/d03e3ce4a01dffb60d8951a3ac13f17db37c3415), [`b1a22d7`](https://github.com/LTplus-AG/ifc-lite/commit/b1a22d721e4873883badbdb637630ea0ff88ea82), [`aef7203`](https://github.com/LTplus-AG/ifc-lite/commit/aef7203665f5374f2e867aa4bd43f26ef517c578), [`2343871`](https://github.com/LTplus-AG/ifc-lite/commit/2343871ceed4f42503e770c0a4e593e8827e9f91), [`5f3a915`](https://github.com/LTplus-AG/ifc-lite/commit/5f3a915bc061d4155fb80a6f195b845f4a147a6b), [`8d6df23`](https://github.com/LTplus-AG/ifc-lite/commit/8d6df23e670fbdd771643631d8960db6af99c6da), [`d731f16`](https://github.com/LTplus-AG/ifc-lite/commit/d731f16988996bcba5f5ef01283cdf1c8ab041ba), [`b5920f3`](https://github.com/LTplus-AG/ifc-lite/commit/b5920f316c6dd27030f8b2390deb803a0b9deef8), [`74ba2f2`](https://github.com/LTplus-AG/ifc-lite/commit/74ba2f24e664b37b96e871620fbfdbab653042f3), [`bb42608`](https://github.com/LTplus-AG/ifc-lite/commit/bb426086f8a3e07d1035f2baa3be973c41cba3e0), [`c53b946`](https://github.com/LTplus-AG/ifc-lite/commit/c53b946b5411d613fb5316f48fd03949cf656f75), [`a1b2b77`](https://github.com/LTplus-AG/ifc-lite/commit/a1b2b77d7d3de6878d14e73d888e04b50295a5e2), [`b4bc7df`](https://github.com/LTplus-AG/ifc-lite/commit/b4bc7df25e9cdcd6c46f4affd289c0b3da7829fa), [`9f32c63`](https://github.com/LTplus-AG/ifc-lite/commit/9f32c63083c9341871adac1d645c533c7afcac87), [`a2bc270`](https://github.com/LTplus-AG/ifc-lite/commit/a2bc270fb652466f4bd30511aa560997637ee83b), [`eb1b2b1`](https://github.com/LTplus-AG/ifc-lite/commit/eb1b2b1704d0ad5c8a0ee546871e8a266eb53955), [`4091265`](https://github.com/LTplus-AG/ifc-lite/commit/4091265e59279c87444d13f1d25537c00a430797), [`ec446fd`](https://github.com/LTplus-AG/ifc-lite/commit/ec446fd10b5e09724d88be75400119c1456afe6a), [`5ae670d`](https://github.com/LTplus-AG/ifc-lite/commit/5ae670d9701623b98414aafbedc3e8606db9bfa3), [`bbedaf6`](https://github.com/LTplus-AG/ifc-lite/commit/bbedaf629c635e102a3f65e2f7ba3feb77300d98), [`5a82260`](https://github.com/LTplus-AG/ifc-lite/commit/5a82260e3e0bf686851e724b24dbfa05d11d9c7c), [`6d8ebeb`](https://github.com/LTplus-AG/ifc-lite/commit/6d8ebebb7cd8722534ff1ad7817cf7a7d0191aaf), [`9b9f2df`](https://github.com/LTplus-AG/ifc-lite/commit/9b9f2df47e0b1192fe033ca36021499af532220b), [`a4e04e7`](https://github.com/LTplus-AG/ifc-lite/commit/a4e04e7868d6950e0139145319265788699d0afd), [`1f0f2ad`](https://github.com/LTplus-AG/ifc-lite/commit/1f0f2ad8fd3476cb705b0d32e00d07f874705088), [`c3492d1`](https://github.com/LTplus-AG/ifc-lite/commit/c3492d188d9353778dcb62e491cc8b1987d93767), [`7f31b01`](https://github.com/LTplus-AG/ifc-lite/commit/7f31b014f917ac038a316867673528810d9ba46a), [`9df0f93`](https://github.com/LTplus-AG/ifc-lite/commit/9df0f936e291c509c5914a8418535b1dae505517), [`2ecf0f0`](https://github.com/LTplus-AG/ifc-lite/commit/2ecf0f096d0f2d6079963040d3293e5964785486), [`be2fed0`](https://github.com/LTplus-AG/ifc-lite/commit/be2fed0945e7dff83e3fb5d9ba810f0b5a6339a7), [`56cc096`](https://github.com/LTplus-AG/ifc-lite/commit/56cc09672219d33e094b81d419d360ca3ec6e26e), [`4db9471`](https://github.com/LTplus-AG/ifc-lite/commit/4db9471098a42ed948c4920cce1cb71a99d60d6a), [`478b5fb`](https://github.com/LTplus-AG/ifc-lite/commit/478b5fba37108dd0cf19cd2f71d71158e204f42f), [`6f5e74b`](https://github.com/LTplus-AG/ifc-lite/commit/6f5e74b028d4e8a2b94b05ead18163dd0c46ce9a), [`4986957`](https://github.com/LTplus-AG/ifc-lite/commit/4986957c383b88616f3807ee5fe27d41fb0380f4), [`be2fed0`](https://github.com/LTplus-AG/ifc-lite/commit/be2fed0945e7dff83e3fb5d9ba810f0b5a6339a7)]:
  - @ifc-lite/wasm@9.0.0
  - @ifc-lite/parser@6.4.0
  - @ifc-lite/export@4.3.2
  - @ifc-lite/geometry@7.0.0
  - @ifc-lite/server-client@2.2.0
  - @ifc-lite/data@4.4.0
  - @ifc-lite/cache@3.4.3
  - @ifc-lite/query@2.3.4
  - @ifc-lite/sdk@5.1.0
  - @ifc-lite/sandbox@2.3.0
  - @ifc-lite/mcp@0.15.0
  - @ifc-lite/clash@2.2.1
  - @ifc-lite/ids@1.16.6
  - @ifc-lite/drawing-2d@4.0.3
  - @ifc-lite/renderer@3.0.1
  - @ifc-lite/spatial@1.14.19
  - @ifc-lite/lists@2.2.3

## 1.15.3

### Patch Changes

- Updated dependencies [[`0bd9521`](https://github.com/LTplus-AG/ifc-lite/commit/0bd9521554b616c101ab61425d6dc46beb3e904d), [`7562e5b`](https://github.com/LTplus-AG/ifc-lite/commit/7562e5b3f62ec57ca49cd412e35489bbf9e2ee6e), [`9a7710c`](https://github.com/LTplus-AG/ifc-lite/commit/9a7710c9c66e2285aeb215aec5600dfbce1b070e), [`ec0fcfe`](https://github.com/LTplus-AG/ifc-lite/commit/ec0fcfe5cccec94b28fa1887822f0046b7522812), [`e18a434`](https://github.com/LTplus-AG/ifc-lite/commit/e18a434ec2258e474728bd9a90146486b38efedb), [`624bfa3`](https://github.com/LTplus-AG/ifc-lite/commit/624bfa3b7d1d636a6142af984613eb5bd79c09b4), [`3b7d860`](https://github.com/LTplus-AG/ifc-lite/commit/3b7d8609267a25261a55623886fd0a0233c1d24e), [`1996e92`](https://github.com/LTplus-AG/ifc-lite/commit/1996e9281b8d36585c3faba940a0f56be4ef706b), [`8d49593`](https://github.com/LTplus-AG/ifc-lite/commit/8d49593994df9a11b9d658397b70e9211496ce28), [`e94a233`](https://github.com/LTplus-AG/ifc-lite/commit/e94a233a8fce5be0e9d6fa833f6a5fc121961e08), [`535055e`](https://github.com/LTplus-AG/ifc-lite/commit/535055ed47af49a22bc04788a1ff7e5755a54933), [`6f339d8`](https://github.com/LTplus-AG/ifc-lite/commit/6f339d8165104cd44f6c6c36371c205ec3cccafb), [`74aa364`](https://github.com/LTplus-AG/ifc-lite/commit/74aa364a14360f2af67a1902d7760b623d95c029), [`4eef3be`](https://github.com/LTplus-AG/ifc-lite/commit/4eef3be61bcc6fea16fb1a4376a7d7340ab5dc69), [`94074df`](https://github.com/LTplus-AG/ifc-lite/commit/94074df5c7e53557e45dd838ce22990c19544df8), [`ad4672f`](https://github.com/LTplus-AG/ifc-lite/commit/ad4672fc9007f8ac86076f123a1e6020b04af7b6), [`6295f8b`](https://github.com/LTplus-AG/ifc-lite/commit/6295f8b58ee5f85be27470463e4f333f5aa11b35), [`ed38bfc`](https://github.com/LTplus-AG/ifc-lite/commit/ed38bfc562cb170458141c5abecf15c0c0e2ea4d), [`53003de`](https://github.com/LTplus-AG/ifc-lite/commit/53003de1e36a956b7f51e9dffc035218477d5d3c), [`315b5cc`](https://github.com/LTplus-AG/ifc-lite/commit/315b5cc5f2dc9b4add51c60bb891bfcf52f654da), [`5583362`](https://github.com/LTplus-AG/ifc-lite/commit/5583362ea8d7c988c84d44bf3b27c6c72fb6b798), [`0d8c5da`](https://github.com/LTplus-AG/ifc-lite/commit/0d8c5dac6175255d12ce758fe69c177af849dd03), [`6cc1b43`](https://github.com/LTplus-AG/ifc-lite/commit/6cc1b4362ed7ab2e909b81995bd7d4d99bc268d0), [`4ab63cd`](https://github.com/LTplus-AG/ifc-lite/commit/4ab63cd72e374dbdc98b6f59599fb9d2050f0f85), [`f7ea57f`](https://github.com/LTplus-AG/ifc-lite/commit/f7ea57f0555ca77695e28e41cfcfb0e9e7e3a2bb), [`ad8fde2`](https://github.com/LTplus-AG/ifc-lite/commit/ad8fde2c9cd1bdf4c6a6b097e745e84306951e1b), [`a3aaaf0`](https://github.com/LTplus-AG/ifc-lite/commit/a3aaaf0832b0924237841075f37e76391ef200a2)]:
  - @ifc-lite/wasm@8.0.0
  - @ifc-lite/clash@2.2.0
  - @ifc-lite/export@4.3.0
  - @ifc-lite/collab@0.8.0
  - @ifc-lite/renderer@3.0.0
  - @ifc-lite/pointcloud@0.9.0
  - @ifc-lite/lists@2.2.0
  - @ifc-lite/parser@6.2.0
  - @ifc-lite/mutations@2.3.0
  - @ifc-lite/geometry@6.0.0
  - @ifc-lite/mcp@0.14.2
  - @ifc-lite/ifcx@4.1.1
  - @ifc-lite/ids@1.16.3
  - @ifc-lite/cache@3.4.2
  - @ifc-lite/drawing-2d@4.0.2
  - @ifc-lite/query@2.3.2
  - @ifc-lite/spatial@1.14.18

## 1.15.2

### Patch Changes

- Updated dependencies [[`9a271dc`](https://github.com/LTplus-AG/ifc-lite/commit/9a271dcb19dff2f9bca72fc3505ce5a71b3e800b), [`6fe4fc8`](https://github.com/LTplus-AG/ifc-lite/commit/6fe4fc8ddac8cbc18f3556fa7bfa778bf6115928), [`3fdbc2b`](https://github.com/LTplus-AG/ifc-lite/commit/3fdbc2b599fad2b1c43ffe014d2bab5f8b8c576c), [`39d5158`](https://github.com/LTplus-AG/ifc-lite/commit/39d5158fd5192a14fc2552d73a531b1334831e5a), [`3a1a322`](https://github.com/LTplus-AG/ifc-lite/commit/3a1a3229412b7822438fa5dba653f6c4e1bd239f), [`7f80d53`](https://github.com/LTplus-AG/ifc-lite/commit/7f80d53d2a2c158a322ec541ce064365f3f3ca8a), [`4c9a88d`](https://github.com/LTplus-AG/ifc-lite/commit/4c9a88d80b9ba9631be97050d896b5f5834d3628), [`4c9a88d`](https://github.com/LTplus-AG/ifc-lite/commit/4c9a88d80b9ba9631be97050d896b5f5834d3628), [`dee75d8`](https://github.com/LTplus-AG/ifc-lite/commit/dee75d86d404e5a5ae15e71910704d970d2426a2), [`a53bd7f`](https://github.com/LTplus-AG/ifc-lite/commit/a53bd7fd4510b8d5c992eab26234084c5bb2387e), [`c952d49`](https://github.com/LTplus-AG/ifc-lite/commit/c952d497c424ec15b972d87b878b41bf0573460b), [`5e94b1a`](https://github.com/LTplus-AG/ifc-lite/commit/5e94b1a646d7e02c909b8835f3adf8e0bf4feb5f), [`341f41f`](https://github.com/LTplus-AG/ifc-lite/commit/341f41fd1725e8551d9bae4a3478ea3fa5b2698f), [`1878436`](https://github.com/LTplus-AG/ifc-lite/commit/1878436f58d4b11b8cd69ea4d544373ca375b9eb), [`bbec5c1`](https://github.com/LTplus-AG/ifc-lite/commit/bbec5c1a3d5c581c157f27946bf4b416470818de), [`abda2d8`](https://github.com/LTplus-AG/ifc-lite/commit/abda2d8114ad17b0366f448100953d6e1972164c), [`c952d49`](https://github.com/LTplus-AG/ifc-lite/commit/c952d497c424ec15b972d87b878b41bf0573460b), [`511e488`](https://github.com/LTplus-AG/ifc-lite/commit/511e488a8de2b90f7d5f7663911873a92b3427c7), [`bb1c705`](https://github.com/LTplus-AG/ifc-lite/commit/bb1c705c56754e13b197c266e44f6ed715737432), [`473ad56`](https://github.com/LTplus-AG/ifc-lite/commit/473ad56dbe17e958cf31cd9d6cb9bf6c08875649), [`53c65fe`](https://github.com/LTplus-AG/ifc-lite/commit/53c65fecdac95b4c19a661be923c225d104a7be8), [`a53bd7f`](https://github.com/LTplus-AG/ifc-lite/commit/a53bd7fd4510b8d5c992eab26234084c5bb2387e)]:
  - @ifc-lite/bcf@4.0.0
  - @ifc-lite/sdk@5.0.0
  - @ifc-lite/wasm@7.0.0
  - @ifc-lite/parser@6.1.0
  - @ifc-lite/export@4.2.0
  - @ifc-lite/clash@2.1.2
  - @ifc-lite/geometry@5.0.0
  - @ifc-lite/mcp@0.14.1
  - @ifc-lite/create@2.4.0
  - @ifc-lite/cache@3.4.1
  - @ifc-lite/extensions@0.7.0
  - @ifc-lite/renderer@2.2.0
  - @ifc-lite/data@4.2.0
  - @ifc-lite/query@2.3.1
  - @ifc-lite/sandbox@2.2.4
  - @ifc-lite/ids@1.16.2
  - @ifc-lite/drawing-2d@4.0.1
  - @ifc-lite/spatial@1.14.17
  - @ifc-lite/lists@2.1.2

## 1.15.1

### Patch Changes

- Updated dependencies [[`5e66c93`](https://github.com/LTplus-AG/ifc-lite/commit/5e66c93d98ddb3ec75ebe7e819d6ea15aa2b03c1), [`ced8bb4`](https://github.com/LTplus-AG/ifc-lite/commit/ced8bb46c368648bd54a1bab716d049143faa036), [`069020f`](https://github.com/LTplus-AG/ifc-lite/commit/069020f0ef51e8908c6fe86e6c3da011418d42d8), [`c5e583e`](https://github.com/LTplus-AG/ifc-lite/commit/c5e583e3c25349753dc415184359eba08db9c8ae), [`5580d5a`](https://github.com/LTplus-AG/ifc-lite/commit/5580d5a6fda38b88af3fe64bda19f9b6c995749e), [`8ccd02d`](https://github.com/LTplus-AG/ifc-lite/commit/8ccd02dfa431b9194d7936b8966b5aabf4c34694), [`dd91eb1`](https://github.com/LTplus-AG/ifc-lite/commit/dd91eb1580c117f15bc019275a669437c401ae15), [`c4b7bc2`](https://github.com/LTplus-AG/ifc-lite/commit/c4b7bc2d9e1ecd84efaa02eafff705a46a2f4323), [`e776543`](https://github.com/LTplus-AG/ifc-lite/commit/e77654353eba7281429a2dbe7c7d973b3bbf0d9f), [`934d4e8`](https://github.com/LTplus-AG/ifc-lite/commit/934d4e819a0399b8f0b7d99b9c056e595e55cca5), [`b5cb19a`](https://github.com/LTplus-AG/ifc-lite/commit/b5cb19ae80610107f7b3b3914efa7234dfbe4999), [`098e241`](https://github.com/LTplus-AG/ifc-lite/commit/098e2419cac5bd72f5524c7cddfa1b4da7971696), [`e695110`](https://github.com/LTplus-AG/ifc-lite/commit/e695110acf4bb3e0b3a00324d0c819ccf8886097), [`f794750`](https://github.com/LTplus-AG/ifc-lite/commit/f79475055e9cfe0c7ee19a7732ded546c5a7796a), [`4c58993`](https://github.com/LTplus-AG/ifc-lite/commit/4c5899307dc1e9da62f7a827298d2eb8bb8ada47), [`bc26223`](https://github.com/LTplus-AG/ifc-lite/commit/bc26223b5b7e09c8bafcdf7f95afafe033622867), [`32429a1`](https://github.com/LTplus-AG/ifc-lite/commit/32429a1e460fc4efee4c334037ac49a8738a5e0f), [`e844910`](https://github.com/LTplus-AG/ifc-lite/commit/e844910ce1b09db412687aa1a864649b8d77e4f6), [`cd0e214`](https://github.com/LTplus-AG/ifc-lite/commit/cd0e214cccbf81787a0b9c07735982cb101bad62), [`b6d65a9`](https://github.com/LTplus-AG/ifc-lite/commit/b6d65a9885b2f8e7a4b5d8c6cd2c572a405dda58), [`d4648ad`](https://github.com/LTplus-AG/ifc-lite/commit/d4648adb76466633733236087e527ff3e3780d81), [`e119819`](https://github.com/LTplus-AG/ifc-lite/commit/e1198197556375019c5a7820cc7c99da55e5c639), [`b0700f2`](https://github.com/LTplus-AG/ifc-lite/commit/b0700f25434d1cf1ec5f7438a8e27c09188208ec), [`35fa016`](https://github.com/LTplus-AG/ifc-lite/commit/35fa016128b1c660ff822e6638d3274da68ebe09), [`12e69fe`](https://github.com/LTplus-AG/ifc-lite/commit/12e69feb363ea31fb2c3513436366b01c54251e9), [`83fb539`](https://github.com/LTplus-AG/ifc-lite/commit/83fb539395e3638eb4c72a5c0fb2c508a8746adb), [`f33ac74`](https://github.com/LTplus-AG/ifc-lite/commit/f33ac74dd0578792327f684ba5ca59f050458c65), [`92e5903`](https://github.com/LTplus-AG/ifc-lite/commit/92e59033708882e9d40eaad0cddc7aab1468d2b4), [`0581b28`](https://github.com/LTplus-AG/ifc-lite/commit/0581b28ff4cebf20de2d973b7a9b2f81dcf47275), [`85e0351`](https://github.com/LTplus-AG/ifc-lite/commit/85e0351c6bcbc350c404176e484320baa08a1366), [`6f0078b`](https://github.com/LTplus-AG/ifc-lite/commit/6f0078bc8ae697c9e6f91ae5b36546476b0fee5b), [`04d7b3b`](https://github.com/LTplus-AG/ifc-lite/commit/04d7b3ba0ab64ae9e97420aa8d5c56a536272724), [`7179a9c`](https://github.com/LTplus-AG/ifc-lite/commit/7179a9c6c2d0620f6bd3260e37b80c771697ce85), [`dbf513b`](https://github.com/LTplus-AG/ifc-lite/commit/dbf513b785f1dbc2f2dce5c173d28fd5ab65aa0c), [`637048a`](https://github.com/LTplus-AG/ifc-lite/commit/637048ad9a36c634670210bdf222c1764a2a2386), [`997ba26`](https://github.com/LTplus-AG/ifc-lite/commit/997ba26adcbc170666fc086289fd21edb78813b1), [`be64c7c`](https://github.com/LTplus-AG/ifc-lite/commit/be64c7c3e0a8895869c459a798c2d1163f23c1b9), [`37f44ac`](https://github.com/LTplus-AG/ifc-lite/commit/37f44ac632f54322b89c7813723cad7e8e2b1ba5), [`c80a6cc`](https://github.com/LTplus-AG/ifc-lite/commit/c80a6cc2450252293761bf00174703e2bfd2483f), [`33194e5`](https://github.com/LTplus-AG/ifc-lite/commit/33194e5db6a17763e8fad5f5a6d2fea130d8dc84), [`9c7062f`](https://github.com/LTplus-AG/ifc-lite/commit/9c7062f1f28a2f9d8a46db65225b772af4666cde), [`fc4b6ab`](https://github.com/LTplus-AG/ifc-lite/commit/fc4b6ab4a80a3bcd1a30027b45f30e25ebf2434f), [`e9f7ee8`](https://github.com/LTplus-AG/ifc-lite/commit/e9f7ee83bd2e537a8ece4e80c4440a3c615d4359), [`8fbd804`](https://github.com/LTplus-AG/ifc-lite/commit/8fbd8045272e5cfdfa86518d8eeb92e8be1b1220), [`ed2a067`](https://github.com/LTplus-AG/ifc-lite/commit/ed2a067ca713b14cf0d9b658789d22f4c78c7731), [`aa73bb7`](https://github.com/LTplus-AG/ifc-lite/commit/aa73bb777ada7cec655621496401e4f8cf693a2f), [`8620be3`](https://github.com/LTplus-AG/ifc-lite/commit/8620be38be0162b7cbdbe23ae7bc924763b83612), [`8369d06`](https://github.com/LTplus-AG/ifc-lite/commit/8369d067dba22a7ca69b0420d49bf94bd698edd5), [`1e09d1c`](https://github.com/LTplus-AG/ifc-lite/commit/1e09d1cec57a5c26e82b721a6451185c83c34eb2), [`be4fdb9`](https://github.com/LTplus-AG/ifc-lite/commit/be4fdb9ffe6995c74d3629887021c98b843beadb), [`be4fdb9`](https://github.com/LTplus-AG/ifc-lite/commit/be4fdb9ffe6995c74d3629887021c98b843beadb), [`f3efce7`](https://github.com/LTplus-AG/ifc-lite/commit/f3efce7382d9018a70740909a18ee87b043e5901), [`cabfd37`](https://github.com/LTplus-AG/ifc-lite/commit/cabfd3752d8dc221042990187669a5670be88df8), [`5a01e5a`](https://github.com/LTplus-AG/ifc-lite/commit/5a01e5abe220f21ae5233045c6e9cfc5aa37a4e3), [`49763b4`](https://github.com/LTplus-AG/ifc-lite/commit/49763b48cbc9a18d7bc8f090a3dcc1ca0dc718a2), [`994cf95`](https://github.com/LTplus-AG/ifc-lite/commit/994cf950ab7a09613460f68f9ad16196b0bb64e1), [`a1d41d8`](https://github.com/LTplus-AG/ifc-lite/commit/a1d41d8187e564606d556e46c9a96a8022797234), [`5268ba3`](https://github.com/LTplus-AG/ifc-lite/commit/5268ba33f60577d0707ac5dcfdf3ab45a16e9bd0), [`68a6af8`](https://github.com/LTplus-AG/ifc-lite/commit/68a6af8c58f27895327ca0cf2b218ea15bd14050), [`f55a14e`](https://github.com/LTplus-AG/ifc-lite/commit/f55a14ec02d5a08e22bbd06dd960edc057aa9877), [`7427343`](https://github.com/LTplus-AG/ifc-lite/commit/742734300487f78df8192dc6fd4126615b63b966), [`8620be3`](https://github.com/LTplus-AG/ifc-lite/commit/8620be38be0162b7cbdbe23ae7bc924763b83612), [`2ab5f15`](https://github.com/LTplus-AG/ifc-lite/commit/2ab5f15a60f22cb1ed8f066ff2f41b37e4f76698), [`6ff9efa`](https://github.com/LTplus-AG/ifc-lite/commit/6ff9efaf184d466639516c2728024aa23a2f6b33), [`d39d9a4`](https://github.com/LTplus-AG/ifc-lite/commit/d39d9a499a3fbc81650bfab7562b6d89df4a53f8), [`6110c0d`](https://github.com/LTplus-AG/ifc-lite/commit/6110c0d6bb0c1a96c4da4c056389ebc4dfe26631), [`22f3f0d`](https://github.com/LTplus-AG/ifc-lite/commit/22f3f0d0d6e5088908107a183a883b87c35c4ddf), [`52532e0`](https://github.com/LTplus-AG/ifc-lite/commit/52532e01ed9513cd49144f935fd282c19158339d), [`8f8b017`](https://github.com/LTplus-AG/ifc-lite/commit/8f8b0179be76fea8cb7f21b34bb6408084e410af), [`a88027b`](https://github.com/LTplus-AG/ifc-lite/commit/a88027b9ae642da850a3515d8eef83d750b655b3), [`8198c44`](https://github.com/LTplus-AG/ifc-lite/commit/8198c44e0297657f7775a3ee6bd10855bd23c132), [`7934571`](https://github.com/LTplus-AG/ifc-lite/commit/7934571755febaae5287cc4a876bcf2c8b8b2463), [`d4e7b99`](https://github.com/LTplus-AG/ifc-lite/commit/d4e7b99baa4349f1ae096fc2f194e46a8049ccb9), [`be4fdb9`](https://github.com/LTplus-AG/ifc-lite/commit/be4fdb9ffe6995c74d3629887021c98b843beadb), [`fedb41a`](https://github.com/LTplus-AG/ifc-lite/commit/fedb41aeec7d84ab54bb39625c4056ff95264269), [`b9c3aa1`](https://github.com/LTplus-AG/ifc-lite/commit/b9c3aa1b7da9b0c26742bacb6eb3c7c4b44ca80b), [`6af5d45`](https://github.com/LTplus-AG/ifc-lite/commit/6af5d455fec7cc5467fa565babd82be611242e02), [`6af5d45`](https://github.com/LTplus-AG/ifc-lite/commit/6af5d455fec7cc5467fa565babd82be611242e02), [`227a93c`](https://github.com/LTplus-AG/ifc-lite/commit/227a93cd166376b76c9feaa74e7f7fad27f5c941), [`379852a`](https://github.com/LTplus-AG/ifc-lite/commit/379852a658bae039f312dcb8547629703891d2f9), [`ae85338`](https://github.com/LTplus-AG/ifc-lite/commit/ae8533851faa4fe9508d36cfb1a2ca99c240ec7b), [`a6976b9`](https://github.com/LTplus-AG/ifc-lite/commit/a6976b9da44d13157533372a8def23995fcfb93f), [`591c593`](https://github.com/LTplus-AG/ifc-lite/commit/591c5938bdc4e8210c3b3158f22ecd78552bcdc2), [`576369b`](https://github.com/LTplus-AG/ifc-lite/commit/576369b2168ee1277fab3cfbc42d54c356aec0ef), [`6138db1`](https://github.com/LTplus-AG/ifc-lite/commit/6138db1220bd148f8226c922255441a2047d2c6b), [`ef70500`](https://github.com/LTplus-AG/ifc-lite/commit/ef70500d316a454b3e668d943ae95430c2cfe53c)]:
  - @ifc-lite/renderer@2.1.0
  - @ifc-lite/data@4.1.0
  - @ifc-lite/parser@6.0.0
  - @ifc-lite/query@2.3.0
  - @ifc-lite/wasm@6.5.0
  - @ifc-lite/server-client@2.1.0
  - @ifc-lite/export@4.1.0
  - @ifc-lite/ids@1.16.1
  - @ifc-lite/create@2.3.0
  - @ifc-lite/pointcloud@0.8.0
  - @ifc-lite/mutations@2.2.0
  - @ifc-lite/ifcx@4.1.0
  - @ifc-lite/geometry@4.4.0
  - @ifc-lite/mcp@0.14.0
  - @ifc-lite/collab@0.7.0
  - @ifc-lite/sdk@4.1.0
  - @ifc-lite/clash@2.1.1
  - @ifc-lite/cache@3.4.0
  - @ifc-lite/extensions@0.6.1
  - @ifc-lite/lists@2.1.1

## 1.15.0

### Minor Changes

- [#3585](https://github.com/LTplus-AG/ifc-lite/pull/3585) [`e76791e`](https://github.com/LTplus-AG/ifc-lite/commit/e76791ea330610f3036ff33b86f99fceaae68a80) Thanks [@louistrue](https://github.com/louistrue)! - Fix isolating a geometry-less entity (an `IfcElementAssembly` or a similar container that owns no mesh of its own) blanking the entire 3D view, in the five isolation channels that never expanded it: the embed bridge's `ISOLATE` command, `?isolate=` URL params, the IDS row isolate, the IDS set isolate (the failed/passed/involved buttons), and the BCF viewpoint isolation mode.
  
  `isolatedEntities` is a whitelist the renderer matches mesh ids against, so isolating a container's own id hides everything. `expandToGeometryBearingIds` swaps such an id for the `IfcRelAggregates` parts that do carry meshes, and it is reachable from exactly one production entry point, `cameraCallbacks.resolveHighlightIds`. Those five channels never called it. Each now routes its ids through `resolvePresentationIds` (`apps/viewer/src/lib/presentation/resolvePresentationIds.ts`), which is also where the two channels that already routed — a lens rule isolate, and the SDK/MCP `isolate()` adapter [#3382](https://github.com/LTplus-AG/ifc-lite/issues/3382) fixed — now get the policy from, so there is one implementation of it instead of one per call site. The policy is [#3382](https://github.com/LTplus-AG/ifc-lite/issues/3382)'s, unchanged: the resolved ids are unioned with the raw ids, never substituted for them ([#2680](https://github.com/LTplus-AG/ifc-lite/issues/2680)).
  
  An empty resolver result keeps the raw ids rather than skipping the isolate. The resolver bounds-checks against the type-visibility filtered mesh list, so `[]` is the answer for three different situations it cannot tell apart from the outside: ids hidden by a type toggle right now (`spaces`, `spatialZones`, `openings` and `virtualElements` all ship off), ids whose meshes have not streamed in yet, and ids that are genuinely geometry-less. Aborting on `[]` would turn "Isolate failed" on an IfcSpace-scoped IDS spec, a lens rule matching spaces, an SDK `isolate()` of a space ref and an embed `?isolate=<a space>` into silent no-ops. Carrying an id that owns no mesh costs nothing: it never matches the whitelist, and the isolation starts showing the right thing the moment the toggle flips or the batch lands. This is the same reasoning `PropertiesPanel.tsx`'s group-member isolate ([#1075](https://github.com/LTplus-AG/ifc-lite/issues/1075)) and `SearchModal.filter.tsx`'s "Isolate in 3D" ([#2660](https://github.com/LTplus-AG/ifc-lite/issues/2660)) already used, which is why those two keep calling the resolver inline rather than being converted.
  
  What this does not fix, stated rather than papered over: when an id is genuinely geometry-less and none of its aggregated parts render either, the isolation is still installed on a set with no mesh in it and the viewport still goes blank ([#3426](https://github.com/LTplus-AG/ifc-lite/issues/3426)). Telling that case apart from a hidden or not-yet-streamed one needs a resolver that can see unfiltered geometry, which is Viewport plumbing rather than a policy this helper can infer.
  
  Three isolation call sites are deliberately not routed, each with its reason recorded in the gate's allowlist: `HierarchyPanel.tsx` isolates ids `treeDataBuilder.ts` already expanded to geometry-bearing members at tree-build time; `useClash.ts` only ever isolates a clash pair, whose ids are geometry-bearing by construction because detection tests actual mesh triangles; and the anonymized-export 3D preview mirrors the export's `includedIds` exactly, so a container that draws nothing there is the truth the preview exists to show.

### Patch Changes

- [#3719](https://github.com/LTplus-AG/ifc-lite/pull/3719) [`4f670aa`](https://github.com/LTplus-AG/ifc-lite/commit/4f670aa0d8e544b5fbe0cd26db34f4fb3974938a) Thanks [@louistrue](https://github.com/louistrue)! - Let `hideTypes` reach the symbolic 2D overlay, so `hideTypes: ['IfcAnnotation']` stops being a silent no-op.
  
  `IfcAnnotation` 2D content is not a mesh. Rust routes every shape representation identified `Plan`, `Annotation`, `FootPrint` or `Axis` into symbolic data (`rust/processing/src/symbolic/mod.rs`), which the viewport draws as a line-and-text overlay gated only on the store's `typeVisibility.ifcAnnotations` and `.ifcGrid`. The embed's `hideTypes` filters the mesh list, so it could never touch that overlay: a host naming `IfcAnnotation` got silence and no error ([#2934](https://github.com/LTplus-AG/ifc-lite/issues/2934)). Measured on AC20-FZK-Haus through the real embed build, five states pixel-diffed against each other: before this change `hideTypes=IfcAnnotation` moved 0 of 960,000 pixels, while turning the store's own annotation toggle off moved 6,492 — the same 6,492 that stripping the 14 `IFCANNOTATION` instances out of the bytes moves. After it, the `hideTypes` states are pixel-identical to both (0 px apart), by either host route: `INIT`'s `config.hideTypes` and `?hideTypes=`.
  
  The embed now publishes its case-folded hidden-class set to `store.hostHiddenIfcTypes`, and the two overlay hooks read it there, beside the per-entity hides they already apply, through one pure function (`lib/symbolic-overlay-gate.ts`). Nothing is threaded through `Viewport`: the overlay is built two levels below it, and a prop would have added a link only `Viewport` could keep honest — and no test mounts `Viewport`, which needs a WebGPU device.
  
  **What `hideTypes` matches, for the 2D overlay.** The class that OWNS the drawn content, taken from the one table the overlay parse itself uses (`lib/overlay-parse/overlay-channels.ts`): dimensions, leaders and room tags are `IfcAnnotation`; grid axes and their bubbles are `IfcGridAxis`, not `IfcGrid`, which owns no drawn content and so hides nothing. Naming a wall or a space removes their meshes and no 2D content — their `Axis` / `FootPrint` representations are not drawn in the 3D viewport at all (they reach the 2D drawing generator, which this does not gate). Should a channel ever draw a second owner class, it switches off only when every class it draws is hidden, so hiding one class can never take another's content with it.
  
  Precedence is unchanged: `hideTypes` and the store toggles both apply, and a class named in `hideTypes` stays hidden when a later `SET_TYPE_VISIBILITY` turns its toggle on, exactly as a hidden `IfcSpace` mesh behaves today. The full viewer sets no host list and renders as before.

- [#3573](https://github.com/LTplus-AG/ifc-lite/pull/3573) [`5d8437f`](https://github.com/LTplus-AG/ifc-lite/commit/5d8437fea25f8600bad110ea4e9fb1afed16268f) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Apply every field of an INIT command's `config` payload, not just `theme`.
  
  `InboundPayloads['INIT']`'s `config` field is the published `EmbedConfig` type (`packages/embed-protocol`) — `theme`, `bg`, `controls`, `hideAxis`, `hideScale`, `hideTypes`. Only `theme` ever reached an actuator; the other five were declared and silently dropped for anyone driving the postMessage protocol directly (the SDK itself never populates `config` at all — it only ever sends `token`, and every one of these fields already has a `?param=` URL equivalent that IS applied). A host setting `config.controls` or `config.hideAxis` on INIT, expecting the same effect its URL-param sibling gets, got nothing.
  
  Each field now reuses the exact actuator its URL param already calls (`setInteractionMode` for `controls`, `setBackgroundColor` for `bg`), so INIT and the URL params cannot drift from each other. `hideAxis`/`hideScale`/`hideTypes` previously had no actuator at all outside the one-time URL parse — `EmbedViewer` read them from a plain object captured once in a `useState` initialiser — so this also makes those three genuinely mutable at runtime via `useEmbedRuntimeOverlays`, not just at mount.

- [#3681](https://github.com/LTplus-AG/ifc-lite/pull/3681) [`158e0ce`](https://github.com/LTplus-AG/ifc-lite/commit/158e0cefebdb3c3e8d5472179280c32ca97a71a8) Thanks [@louistrue](https://github.com/louistrue)! - Render the Model view in the embed, not the type library on top of it.
  
  `EmbedViewer`'s mesh filter gated on `hideTypes` and three `typeVisibility` toggles and applied no `geometryClass` gate at all, so every instanced type copy (class 2) was drawn along with the building it duplicates. Those copies sit at the type's `MappingOrigin` rather than at any occurrence's placement, so on `AC20-FZK-Haus.ifc` they show as an upside-down roof plane and a floating slab, and picking either returns `IfcSlabType` or `IfcWallType` — a type definition, not an element. Orphan type geometry (class 1) was drawn the same way: a model carrying unplaced `IfcXxxType` definitions laid them over the real one.
  
  The full viewer has never had this because its 3D view applies the same predicate, `isMeshVisibleInViewMode` (`apps/viewer/src/lib/type-view-visibility.ts`), with its own incremental scan (`ViewportContainer.tsx:831-856`). The embed calls `selectModelMeshes`, the wrapper that resolves "is anything placed" over a mesh list in one pass, which the 2D drawings already use ([#2058](https://github.com/LTplus-AG/ifc-lite/issues/2058)). One predicate, two entry points ([#957](https://github.com/LTplus-AG/ifc-lite/issues/957), [#1353](https://github.com/LTplus-AG/ifc-lite/issues/1353)). The embed now calls it too, imported across through the `@` alias it already uses for the store, `Viewport` and `useIfc`, rather than restating the rule in a second place that can drift. A pure type-library file (buildingSMART annex-E, zero placed occurrences) still renders its orphan types, because that predicate keeps class 1 when nothing is placed — hiding it there would blank the screen instead of fixing anything. That test is over the whole loaded set, not per model: federate a type-library file alongside a building with `addModel` and the building's occurrences make the type file's orphans read as type-library content, so they are not drawn. The full viewer resolves it the same way and offers the Types view as the way to see them; the embed has no such switch.
  
  No new protocol field: the embed renders the Model view, fixed. Nothing else changes about what a host can hide.

- [#3720](https://github.com/LTplus-AG/ifc-lite/pull/3720) [`6b1ca5b`](https://github.com/LTplus-AG/ifc-lite/commit/6b1ca5b3e8517d1d4bddd44a5c78fa0d6bb8bf7f) Thanks [@louistrue](https://github.com/louistrue)! - Stop the embed re-multiplying `IfcSpace` and `IfcOpeningElement` alpha, so it draws the same store the full viewer does.
  
  **Default appearance changes for hosts that show spaces or openings.** Both are off by default (`TYPE_VISIBILITY_SEMANTIC_DEFAULTS.spaces` and `.openings` are `false`), so an embed that never turns them on is unaffected: those meshes are filtered out before this pass and were never drawn. A host that switches either on, through `setTypeVisibility` or a persisted preference, now sees them at the alpha the Rust styling table assigns (`IfcSpace` 0.3, `IfcOpeningElement` 0.4) rather than the 0.09 and 0.12 the clamp produced. They look roughly three times more solid. That is the appearance the full viewer has had since [#677](https://github.com/LTplus-AG/ifc-lite/issues/677).
  
  `useModelViewGeometry` re-multiplied both classes down to `Math.min(alpha * 0.3, 0.3)` after the visibility filter. `ViewportContainer` removed exactly that under [#677](https://github.com/LTplus-AG/ifc-lite/issues/677), because it stomped lens and property-set colour rules even when the caller had explicitly chosen alpha 1.0, and because the defaults already carry the translucency so applying it twice was never intended. The embed kept it, so the same protocol against the same store produced two pictures.
  
  When it bit: the clamp lived in a React memo, so it only reached the GPU on an upload from that mesh list. That is the initial load, a model swap, colours applied while streaming was still running, and any type-visibility toggle, which re-uploads the visible set. The sequence that reproduces it is colour a space, then turn spaces on, and the space comes back at 0.3.
  
  When it did not: a colour sent after load is unaffected. `SET_COLORS` also queues `pendingMeshColorUpdates`, which `useGeometryStreaming` pushes straight into `scene.updateMeshColors`, while the geometry effect takes its early return on an unchanged mesh count. In that ordering the embed already drew the host's alpha.

- [#3682](https://github.com/LTplus-AG/ifc-lite/pull/3682) [`243a95a`](https://github.com/LTplus-AG/ifc-lite/commit/243a95a09fac2493d551c33cac39b0c79fc9b8bf) Thanks [@louistrue](https://github.com/louistrue)! - `SET_TYPE_VISIBILITY` reaches all seven type-visibility toggles, not three of them.
  
  The viewer store has seven type-visibility controls; the embed protocol declared three (`spaces`, `openings`, `site`). The protocol was written when the store had three, and nothing tied the two sets together, so `spatialZones`, `virtualElements`, `ifcAnnotations` and `ifcGrid` were added to the store and silently never reached a host. A host that sent one got an OK response and no effect.
  
  `@ifc-lite/embed-protocol` gains `TYPE_VISIBILITY_FLAG_KEYS` (a runtime list of all seven, in store order) and `TypeVisibilityFlags` (the payload type built from it, with a doc comment naming the IFC classes each flag gates). `SET_TYPE_VISIBILITY`'s payload is now that type, and `setTypeVisibility` in `@ifc-lite/embed-sdk` takes it instead of its own inline three-field copy. Both are additive: an existing three-field call still compiles and still means the same thing.
  
  Two smaller fixes ride along in the embed viewer. The command handler loops `TYPE_VISIBILITY_FLAG_KEYS` instead of naming three flags by hand, keeping the same "only toggle a flag that actually differs" rule. And the embed's mesh filter now calls `isTypeVisible` from the store's `typeVisibilityFilter`, the file that calls itself the single source of truth for the class-to-toggle mapping, instead of a private copy that named three of the seven mapped classes: `IfcSpatialZone`, `IfcVirtualElement`, `IfcGeographicElement` and 3D `IfcAnnotation` solids now follow their toggles in the embed the way they already did in the full viewer.
  
  `PROTOCOL_VERSION` stays `'1.0'`, and neither side ever compares it, so nothing breaks on a mismatch. But do not read that as safe. A new SDK against an older viewer, which the `origin` option makes a supported deployment, gets a resolved promise and no effect for the four new flags: the same silent no-op this release exists to remove, moved to version skew. `READY` still reports `'1.0'`, so a host cannot feature-detect either. Publish the embed before the SDK. Making the skew detectable needs a version bump, which changes the literal type of every envelope, so it is a separate decision.
  
  The bridge test now pins the protocol list against the store's `TypeVisibility` at runtime (same key set) and at compile time (every protocol key is a store key, and no store key is missing), so the two cannot drift apart again.
  
  Two behaviour notes for existing embeds, because both are visible and neither produces an error.
  
  `IfcSpatialZone` and `IfcVirtualElement` had no gate at all in the embed's private mapping, so they rendered whatever the toggles said. They now follow `spatialZones` and `virtualElements`, which default to off (`IfcVirtualElement` off since [#1133](https://github.com/LTplus-AG/ifc-lite/issues/1133), because non-physical clearance volumes obscure real geometry). An embed that never sends `SET_TYPE_VISIBILITY` and was showing gross-area zones or clearance volumes will stop showing them. That is the fix doing its job, and it matches the full viewer, but it is a change you did not ask for. To keep the old rendering, send `setTypeVisibility({ spatialZones: true, virtualElements: true })`.
  
  `site` changed meaning too, and it is the one flag that already existed, so this reaches hosts using today's API. It gated `IfcSite` alone; through the shared mapping it now also gates `IfcGeographicElement`, the modelled terrain that [#1480](https://github.com/LTplus-AG/ifc-lite/issues/1480) paired with it. A dashboard sending `site: false` to drop the site plate now loses terrain with it.
  
  Defaults are also not a stable starting point. The embed shares the viewer's store, whose initial toggle state comes from `localStorage` on the embed's own origin, and every `SET_TYPE_VISIBILITY` persists back to it. So a returning visitor can start from their last session rather than from the defaults, and because every embed is served from one origin, that state is not scoped per host. This is how the three previous flags already worked; there are now seven of them. A host that needs a deterministic starting state should send `setTypeVisibility(...)` on every load rather than relying on defaults.
  
  Not fixed here, and adjacent enough to name: the embed still re-multiplies `IfcSpace` and `IfcOpeningElement` alpha down to 0.3 in the same filter chain, which `ViewportContainer` dropped under [#677](https://github.com/LTplus-AG/ifc-lite/issues/677) because it stomped explicit colour choices. The clamp lives in a React memo, so it bites whenever geometry is uploaded from that mesh list: the initial load, a model swap, colours that arrive while streaming is still running, and any type-visibility toggle, which re-uploads the visible set. The sequence that reproduces it is colour a space, then turn spaces on, and the space comes back at 0.3. A colour sent after load is not affected, because `SET_COLORS` also queues `pendingMeshColorUpdates` and that reaches `scene.updateMeshColors` directly while the geometry effect early-returns on an unchanged mesh count. It predates this change and needs its own diff.

- [#3585](https://github.com/LTplus-AG/ifc-lite/pull/3585) [`e76791e`](https://github.com/LTplus-AG/ifc-lite/commit/e76791ea330610f3036ff33b86f99fceaae68a80) Thanks [@louistrue](https://github.com/louistrue)! - Fix the embed bridge's `ISOLATE` postMessage command isolating a geometry-less `IfcElementAssembly` by its own id instead of its `IfcRelAggregates` parts, which blanked the embed viewport ([#3338](https://github.com/LTplus-AG/ifc-lite/issues/3338), the same shape [#2531](https://github.com/LTplus-AG/ifc-lite/issues/2531)/[#2532](https://github.com/LTplus-AG/ifc-lite/issues/2532)/[#3382](https://github.com/LTplus-AG/ifc-lite/issues/3382) fixed in five other channels).
  
  Also adds `scripts/check-isolate-expansion-routing.mjs` (CI, "Node tests"): every `isolateEntities(` and `setIsolatedEntities(` call site under `apps/viewer` and `apps/viewer-embed` must either route through `cameraCallbacks.resolveHighlightIds` or be allowlisted with a reviewable reason, so a future channel that forgets the expansion fails CI instead of shipping a blank viewport.

- [#3861](https://github.com/LTplus-AG/ifc-lite/pull/3861) [`adc5fab`](https://github.com/LTplus-AG/ifc-lite/commit/adc5fab7fe9208019dccf890589fb5fa5637ea63) Thanks [@louistrue](https://github.com/louistrue)! - Fix `hide()`, `show()`, `colorize()`, `colorizeAll()` and `resetColors()` doing nothing when given a geometry-less `IfcElementAssembly`, over both the SDK and the embed's postMessage bridge ([#3338](https://github.com/LTplus-AG/ifc-lite/issues/3338)).
  
  Isolation already expanded such an id to its `IfcRelAggregates` parts. Its sibling channels did not, and they fail the same way for the same reason: the renderer matches `hiddenEntities` and the mesh colour map against ids it saw on a MESH, and an assembly carries no mesh of its own. So `hide([assemblyRef])` left every part visible, `colorize([assemblyRef], red)` repainted nothing, and both reported success. The embed bridge's `HIDE`, `SHOW` and `SET_COLORS` commands had the identical gap.
  
  All of them now route through the shared expansion policy, which moved from `lib/isolation/resolveIsolationIds.ts` to `lib/presentation/resolvePresentationIds.ts`. The old name was part of the problem: a `hide` handler author reading "isolation ids" concludes the module is not theirs and hand-rolls the id list, which is exactly the "one call site every channel must remember to use" failure [#3338](https://github.com/LTplus-AG/ifc-lite/issues/3338) is about. The colour channel gets `resolvePresentationColorMap`, which keeps each id paired with its own colour, calls the resolver once per distinct colour rather than once per id, and lets an explicitly named part outrank the colour it would inherit as some assembly's part.
  
  On the MCP side the same expansion moved from the five viewer tools that each remembered to call it into the one `resolveTargetRefs` they all share, so a sixth tool gets it by construction. No behaviour change there.
  
  One consequence worth knowing when scripting: because `colorize` now paints an assembly's parts, `resetColors([assemblyRef])` clears those parts' colours whoever set them — including a colour an earlier, independent `colorize([partRef])` applied. The adapter keeps a flat id-to-colour map with no record of which call wrote each entry, so it cannot tell the two apart. Reset by part rather than by assembly where that matters.
- Updated dependencies [[`1f657d5`](https://github.com/LTplus-AG/ifc-lite/commit/1f657d5e7f82de890b27b10bc1b7c40d8d31203e), [`44a3c95`](https://github.com/LTplus-AG/ifc-lite/commit/44a3c95ac99c46d5eb800c3ff067477329d7bca9), [`8bdb7fe`](https://github.com/LTplus-AG/ifc-lite/commit/8bdb7fef31b8fafd9341bdc59725cacb8983195e), [`b02da88`](https://github.com/LTplus-AG/ifc-lite/commit/b02da889d60f720f1b4a868b48be12a95027f6e6), [`142b84c`](https://github.com/LTplus-AG/ifc-lite/commit/142b84c41036b749e7b64418a882424b9c386edb), [`142b84c`](https://github.com/LTplus-AG/ifc-lite/commit/142b84c41036b749e7b64418a882424b9c386edb), [`3284390`](https://github.com/LTplus-AG/ifc-lite/commit/328439014322dafaecb1bc930cd66ce5192c3c74), [`bbcb476`](https://github.com/LTplus-AG/ifc-lite/commit/bbcb476209a96b3c8a97f11751f4540cdaf41919), [`bbcb476`](https://github.com/LTplus-AG/ifc-lite/commit/bbcb476209a96b3c8a97f11751f4540cdaf41919), [`bbcb476`](https://github.com/LTplus-AG/ifc-lite/commit/bbcb476209a96b3c8a97f11751f4540cdaf41919), [`1d51937`](https://github.com/LTplus-AG/ifc-lite/commit/1d519376392e405645166761cc537bfbed9083cf), [`18e4de8`](https://github.com/LTplus-AG/ifc-lite/commit/18e4de865884d3126f478a9081cf56178fefcd00), [`80398a9`](https://github.com/LTplus-AG/ifc-lite/commit/80398a944093e3607944c70803b82d64fc372cba), [`9e45546`](https://github.com/LTplus-AG/ifc-lite/commit/9e455460f81f4bd463ef65116cbd89000e5539f7), [`06f81fe`](https://github.com/LTplus-AG/ifc-lite/commit/06f81fe10ba35a5b8edc7848017017f1f4d045ea), [`3e117c2`](https://github.com/LTplus-AG/ifc-lite/commit/3e117c249e792362ee5ec7eb722cf400ee18940a), [`f283c62`](https://github.com/LTplus-AG/ifc-lite/commit/f283c62da53d672d590322edd3351e7b71724757), [`c4fb369`](https://github.com/LTplus-AG/ifc-lite/commit/c4fb36908b350829e73217851c07d9a2e6de74fb), [`f98e601`](https://github.com/LTplus-AG/ifc-lite/commit/f98e601e5efc749088949665e41efd44f1b889c4), [`a1aebc8`](https://github.com/LTplus-AG/ifc-lite/commit/a1aebc822b819221258f4759edf4c82ff0d140f7), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`21b131d`](https://github.com/LTplus-AG/ifc-lite/commit/21b131d77e9079edc80ccf1dc1708c2d65747ae7), [`082fd0b`](https://github.com/LTplus-AG/ifc-lite/commit/082fd0bf0d8f472acdadac438bd43523826491ce), [`70acd06`](https://github.com/LTplus-AG/ifc-lite/commit/70acd063b99d5581f74f50e941df3d997cdebe91), [`56a0e01`](https://github.com/LTplus-AG/ifc-lite/commit/56a0e0112a22f58ac779534427781500c2256826), [`c5da727`](https://github.com/LTplus-AG/ifc-lite/commit/c5da72799a1832d7040942fa621c50973896b7fd), [`53a92b1`](https://github.com/LTplus-AG/ifc-lite/commit/53a92b1f7cc5770f164dc4867fc2adc33470e245), [`8904273`](https://github.com/LTplus-AG/ifc-lite/commit/890427360361fba5232bef614371fe69d9528e47), [`bcbe7b9`](https://github.com/LTplus-AG/ifc-lite/commit/bcbe7b9afa38e8dafb5900e73575c71a8fd96012), [`7b79a93`](https://github.com/LTplus-AG/ifc-lite/commit/7b79a93f80afe104ebe3e20ae742af26b48b21a2), [`82343f7`](https://github.com/LTplus-AG/ifc-lite/commit/82343f75dd2e6029946cbcd0990d3f8fd38a26ad), [`55b69fb`](https://github.com/LTplus-AG/ifc-lite/commit/55b69fbac09155f4cc9c8b2eecba17fd84067c32), [`36719c2`](https://github.com/LTplus-AG/ifc-lite/commit/36719c22f2cbd6027d8afc73c660cda5c994fdf4), [`b9c8fdf`](https://github.com/LTplus-AG/ifc-lite/commit/b9c8fdfbc5e224003fa2094f7b9703aa71600dbf), [`59fae4c`](https://github.com/LTplus-AG/ifc-lite/commit/59fae4cb4c4841b27cbe26a618648407d74d2326), [`9f945d1`](https://github.com/LTplus-AG/ifc-lite/commit/9f945d1e2193cb27e5471f5272496b2791975ede), [`793fce2`](https://github.com/LTplus-AG/ifc-lite/commit/793fce217039f11d6b74f898daed03f48c33809d), [`b0a6265`](https://github.com/LTplus-AG/ifc-lite/commit/b0a6265a804099b9cea7e55f26fc50825c1df07a), [`eb142e0`](https://github.com/LTplus-AG/ifc-lite/commit/eb142e00bc8ad1d6c699ea42fdbc35a9281d8133), [`2b594d2`](https://github.com/LTplus-AG/ifc-lite/commit/2b594d20616f957f7ef949aa8563274e5373a95b), [`2b594d2`](https://github.com/LTplus-AG/ifc-lite/commit/2b594d20616f957f7ef949aa8563274e5373a95b), [`586fa29`](https://github.com/LTplus-AG/ifc-lite/commit/586fa292b69cdb3ba6e45764b4ff742b2fa7b9a9), [`fb72ba8`](https://github.com/LTplus-AG/ifc-lite/commit/fb72ba8cfdb2622e2354015151937ea5f7766dcd), [`49f607e`](https://github.com/LTplus-AG/ifc-lite/commit/49f607e8e27c42e0aacc0fb7a82c8915fe17e23c), [`445d813`](https://github.com/LTplus-AG/ifc-lite/commit/445d813b8ea3b6a09f2930a3e409ccaeff316a85), [`37ce0d0`](https://github.com/LTplus-AG/ifc-lite/commit/37ce0d0ab9587b8bb1098dc05cc4e3a44c6f4741), [`243a95a`](https://github.com/LTplus-AG/ifc-lite/commit/243a95a09fac2493d551c33cac39b0c79fc9b8bf), [`10b45b5`](https://github.com/LTplus-AG/ifc-lite/commit/10b45b571e2c2832bd938bb2a89e6d85d80aed5d), [`3efe762`](https://github.com/LTplus-AG/ifc-lite/commit/3efe762a993897fc3ddc029a8de1e5914e27df3f), [`e8682d5`](https://github.com/LTplus-AG/ifc-lite/commit/e8682d5add8bf0fb08c6cafcfbdf3b6784e3b47e), [`0b9cf1f`](https://github.com/LTplus-AG/ifc-lite/commit/0b9cf1fd12a9cc046c442fb45bae0a94a3378dc5), [`d08e420`](https://github.com/LTplus-AG/ifc-lite/commit/d08e420c9f39e9c0427aba47966cc6acf12642cc), [`9fb14d1`](https://github.com/LTplus-AG/ifc-lite/commit/9fb14d11896c52e51e0334bdaad33fabf166c136), [`c3f0da3`](https://github.com/LTplus-AG/ifc-lite/commit/c3f0da3ccaf6bc98c02ae254c37eeef01c308ba1), [`05193c9`](https://github.com/LTplus-AG/ifc-lite/commit/05193c9a9fd878f70bd9d9007199166fee05872b), [`ddc0221`](https://github.com/LTplus-AG/ifc-lite/commit/ddc0221a776bce15348d915a861e3fbc6cdff968), [`b264887`](https://github.com/LTplus-AG/ifc-lite/commit/b26488758f481c489e7f596568adfe237dd444da), [`3d11231`](https://github.com/LTplus-AG/ifc-lite/commit/3d11231806fec3047c9ed32b9d095be3abe60c2f), [`62399a4`](https://github.com/LTplus-AG/ifc-lite/commit/62399a456661d3db7dd3f86f01a26f4fe8ca594c), [`140a6d8`](https://github.com/LTplus-AG/ifc-lite/commit/140a6d8541224341835c98028dc75e6a5ccd605d), [`801e697`](https://github.com/LTplus-AG/ifc-lite/commit/801e697ea09cad23839b032fd593eb363bf8455b), [`7160b73`](https://github.com/LTplus-AG/ifc-lite/commit/7160b73d573e276e390f62c065b66eb80862c1c5), [`5f44fec`](https://github.com/LTplus-AG/ifc-lite/commit/5f44fec2630bff04fde00dac0eeeb520854dcde1), [`49581d6`](https://github.com/LTplus-AG/ifc-lite/commit/49581d6f3a622d34f677661651c778a36a01e88b), [`34aacc6`](https://github.com/LTplus-AG/ifc-lite/commit/34aacc689d26cbaa15c3bdd4c06d5c710f5676c6), [`e09b5c3`](https://github.com/LTplus-AG/ifc-lite/commit/e09b5c364138d56816e45452622078e951e051ee), [`5297514`](https://github.com/LTplus-AG/ifc-lite/commit/52975142846390bb1eb12b723d53c0e275289a90), [`f76b3a1`](https://github.com/LTplus-AG/ifc-lite/commit/f76b3a1fe729acbf8fea40766ba8d068721f09df), [`6aa2b76`](https://github.com/LTplus-AG/ifc-lite/commit/6aa2b76d4a988e7ee1fd6bcad7c46a41650704b3), [`df878b3`](https://github.com/LTplus-AG/ifc-lite/commit/df878b36fa8cf62878f25d177a15163fec354139), [`1000dce`](https://github.com/LTplus-AG/ifc-lite/commit/1000dce72e9ec75c59848efefc1f709d01172e72), [`9ffdb35`](https://github.com/LTplus-AG/ifc-lite/commit/9ffdb35a9282adf3334a8df26f4a3c80f7f41582), [`1000dce`](https://github.com/LTplus-AG/ifc-lite/commit/1000dce72e9ec75c59848efefc1f709d01172e72), [`1000dce`](https://github.com/LTplus-AG/ifc-lite/commit/1000dce72e9ec75c59848efefc1f709d01172e72), [`b7db4d2`](https://github.com/LTplus-AG/ifc-lite/commit/b7db4d2e51aaf551d3681f07a28921536362bdd7), [`c230fba`](https://github.com/LTplus-AG/ifc-lite/commit/c230fba047d44f79ae36d271446700ad22c62bb3), [`c6b3e1c`](https://github.com/LTplus-AG/ifc-lite/commit/c6b3e1c1e699108f7ece83315b16b780fc4d8a33), [`499ccf2`](https://github.com/LTplus-AG/ifc-lite/commit/499ccf2f97fe1e24728eb4eb99f895044c36f7b2), [`afb9725`](https://github.com/LTplus-AG/ifc-lite/commit/afb972525bb99e3056ccaa84ee7a78e0c7de81ef), [`c1390f3`](https://github.com/LTplus-AG/ifc-lite/commit/c1390f38e32f7a345a4f2651b8a3b6d849e56af6), [`5dbc51d`](https://github.com/LTplus-AG/ifc-lite/commit/5dbc51d053b3a5d7ffa833374215c336c60548cc), [`abae27b`](https://github.com/LTplus-AG/ifc-lite/commit/abae27b5a08c3c5c8a706d144f3f5a08de096d93), [`2329b20`](https://github.com/LTplus-AG/ifc-lite/commit/2329b20506160171da97af7d4dd0cd76ab85f13f), [`d733175`](https://github.com/LTplus-AG/ifc-lite/commit/d733175d4ac2e8a2e94fc0bf9804d7bc03627cc1), [`6bd2550`](https://github.com/LTplus-AG/ifc-lite/commit/6bd25508dadd14fee97ee1f7393212cdcc086fdc), [`15d6d96`](https://github.com/LTplus-AG/ifc-lite/commit/15d6d96adbc4b36a3f787c2d111aaa199403193e), [`32104cb`](https://github.com/LTplus-AG/ifc-lite/commit/32104cbb5c59ea7af0b7b69d27fce15d17627723), [`f7a17ca`](https://github.com/LTplus-AG/ifc-lite/commit/f7a17ca6bedff238ac22315278657801ac41ede0), [`233da61`](https://github.com/LTplus-AG/ifc-lite/commit/233da6172abd3f79cbcde6e827e503fe8eb3ac3e), [`15d6d96`](https://github.com/LTplus-AG/ifc-lite/commit/15d6d96adbc4b36a3f787c2d111aaa199403193e), [`32b31bc`](https://github.com/LTplus-AG/ifc-lite/commit/32b31bc8501f04e110733289bde0389b9899bc76), [`d46732e`](https://github.com/LTplus-AG/ifc-lite/commit/d46732ec22638a5391aa2c04f473795a12c4ab55), [`7f670f9`](https://github.com/LTplus-AG/ifc-lite/commit/7f670f934d52f789ef7800badb3bb74bad56681c), [`cebcb21`](https://github.com/LTplus-AG/ifc-lite/commit/cebcb2133ef672e9199ee2f158578499d449d9e0), [`e986c81`](https://github.com/LTplus-AG/ifc-lite/commit/e986c81bf6d28fec57f1953fa53bf315dbd80a3a), [`8c181c9`](https://github.com/LTplus-AG/ifc-lite/commit/8c181c99f91964402ad352aead36d9619af5b427), [`6e48c4c`](https://github.com/LTplus-AG/ifc-lite/commit/6e48c4c5f441e8a42e4cc55440cf747ad8679f0a), [`8f08715`](https://github.com/LTplus-AG/ifc-lite/commit/8f087158a662a02c01a21dd2546fb863bb24e665), [`9b709c5`](https://github.com/LTplus-AG/ifc-lite/commit/9b709c51480fbabb68167aa4892f7e4c87b0e4e6), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`32b31bc`](https://github.com/LTplus-AG/ifc-lite/commit/32b31bc8501f04e110733289bde0389b9899bc76), [`843aefb`](https://github.com/LTplus-AG/ifc-lite/commit/843aefb9333ae1ad2af24a26fdec889b83de48ed), [`b777dbb`](https://github.com/LTplus-AG/ifc-lite/commit/b777dbb085d70f7f56c15c50b48e3c8e57c889a7), [`62bb58f`](https://github.com/LTplus-AG/ifc-lite/commit/62bb58fc8364c27bcf8452ab8edbde26727f527c), [`ea81645`](https://github.com/LTplus-AG/ifc-lite/commit/ea81645f7cd47d9e62718a6687f9e780794c2aa2), [`74d76bb`](https://github.com/LTplus-AG/ifc-lite/commit/74d76bb52d03397734022855c9cbcd6bdef38632), [`de9d10a`](https://github.com/LTplus-AG/ifc-lite/commit/de9d10af48cc8051456ec368394ab0daffaf1c9e), [`fc68d01`](https://github.com/LTplus-AG/ifc-lite/commit/fc68d01be55aa630a3817a28943d88ff33386b25), [`96d8f41`](https://github.com/LTplus-AG/ifc-lite/commit/96d8f4126073250e079d7cdc8f77b409e70400e7), [`020932a`](https://github.com/LTplus-AG/ifc-lite/commit/020932aade4a506b5e6e6e27ddb706884660f995), [`a8c48ee`](https://github.com/LTplus-AG/ifc-lite/commit/a8c48eed679a31ef0c44782ee19c0889cef5a665), [`c6ffda4`](https://github.com/LTplus-AG/ifc-lite/commit/c6ffda4789099a45fafdb5fe237c33c6edd9884c), [`3b266b9`](https://github.com/LTplus-AG/ifc-lite/commit/3b266b99dac5e384c48a410df7074803b01ef20f), [`cbbb409`](https://github.com/LTplus-AG/ifc-lite/commit/cbbb4090e357abffd57a80f874721d916188ce08), [`d2fb0e4`](https://github.com/LTplus-AG/ifc-lite/commit/d2fb0e4121ccd19f326837ea574b189ee2a5f6c8), [`0a372b7`](https://github.com/LTplus-AG/ifc-lite/commit/0a372b7f3d6cce197ef3e4772267236b570a4447), [`32c5172`](https://github.com/LTplus-AG/ifc-lite/commit/32c51722003e58947c922507bfa7457050025114), [`b964918`](https://github.com/LTplus-AG/ifc-lite/commit/b964918c53992b18ea3fc29be540e1ab28470371), [`a4a498b`](https://github.com/LTplus-AG/ifc-lite/commit/a4a498bcb84c927862ea5ffcd865465e4c3a1a5f), [`2b594d2`](https://github.com/LTplus-AG/ifc-lite/commit/2b594d20616f957f7ef949aa8563274e5373a95b), [`cb56282`](https://github.com/LTplus-AG/ifc-lite/commit/cb56282133a3349299665859b5507b739808d32e), [`f326aa0`](https://github.com/LTplus-AG/ifc-lite/commit/f326aa03fd263b15b8188767520085fe635bf430), [`cbbb409`](https://github.com/LTplus-AG/ifc-lite/commit/cbbb4090e357abffd57a80f874721d916188ce08), [`89c4cf2`](https://github.com/LTplus-AG/ifc-lite/commit/89c4cf22e83d76115035f7dcbf6e34f9c06dd091), [`f41116a`](https://github.com/LTplus-AG/ifc-lite/commit/f41116af2bc41b349053c0eeeff7a276e0915879), [`fc40d01`](https://github.com/LTplus-AG/ifc-lite/commit/fc40d013a739c8921aa9cd8d7d56644a6c18af6c), [`c78ce8c`](https://github.com/LTplus-AG/ifc-lite/commit/c78ce8c3f1da3b8b2c6fa0f982595adc8c48b7d6), [`4246aaa`](https://github.com/LTplus-AG/ifc-lite/commit/4246aaa2035124dbe827827155dbbac2851fda4e), [`eb3000a`](https://github.com/LTplus-AG/ifc-lite/commit/eb3000aa21f13528bb75861f0f810bfc93c91fcc), [`b45180b`](https://github.com/LTplus-AG/ifc-lite/commit/b45180b7821014c1be6835201fa7a45b528c6377), [`a3d5a3a`](https://github.com/LTplus-AG/ifc-lite/commit/a3d5a3a23b6638a4cc68d9bb0da55035d4176bd0), [`3174ee9`](https://github.com/LTplus-AG/ifc-lite/commit/3174ee9d5b72d3d07c7b8c41238ae84221ae89fd), [`858b75a`](https://github.com/LTplus-AG/ifc-lite/commit/858b75a0ef5636098452a2297277767efdc956a2), [`19f1312`](https://github.com/LTplus-AG/ifc-lite/commit/19f13120a05cd3a3b729eeaf5550cff71b7506d9), [`82c77c1`](https://github.com/LTplus-AG/ifc-lite/commit/82c77c118d5a4be8e5ee5b7f7e0648514e9fb74e), [`456d189`](https://github.com/LTplus-AG/ifc-lite/commit/456d1898cdfdc1e31b145777b0f33bad203cc62a), [`d33deb9`](https://github.com/LTplus-AG/ifc-lite/commit/d33deb93e4d40323b76583a2c5ce7e6f0dcdf919), [`b7efeac`](https://github.com/LTplus-AG/ifc-lite/commit/b7efeac2195908729d1bf571839e2607f43c8ff7), [`4735f1c`](https://github.com/LTplus-AG/ifc-lite/commit/4735f1cbb6635016e83c7890f670e615bbdc48c3), [`4475e58`](https://github.com/LTplus-AG/ifc-lite/commit/4475e583ea35def444fb6d7ba92410629bd89096), [`182215a`](https://github.com/LTplus-AG/ifc-lite/commit/182215a835c4beac6a776bcb4eb1d019cab9063e), [`f1a006a`](https://github.com/LTplus-AG/ifc-lite/commit/f1a006af952dd670c6486cdb4ef0e8e1e0e280d7), [`3e61c40`](https://github.com/LTplus-AG/ifc-lite/commit/3e61c407e8b274c85ea4c74bd3b0d63cfc1c300f), [`4c00738`](https://github.com/LTplus-AG/ifc-lite/commit/4c007381bf14b3a4885adfea9b921beb105a8cc3), [`4475e58`](https://github.com/LTplus-AG/ifc-lite/commit/4475e583ea35def444fb6d7ba92410629bd89096), [`afa717b`](https://github.com/LTplus-AG/ifc-lite/commit/afa717bcf6041ad34085626fcfac321207ce4b81), [`6bd2550`](https://github.com/LTplus-AG/ifc-lite/commit/6bd25508dadd14fee97ee1f7393212cdcc086fdc), [`cb56282`](https://github.com/LTplus-AG/ifc-lite/commit/cb56282133a3349299665859b5507b739808d32e), [`d733175`](https://github.com/LTplus-AG/ifc-lite/commit/d733175d4ac2e8a2e94fc0bf9804d7bc03627cc1), [`fdac473`](https://github.com/LTplus-AG/ifc-lite/commit/fdac4734ce04758d2cd12b365f8b6de624713de6), [`902768e`](https://github.com/LTplus-AG/ifc-lite/commit/902768e138b595b26a47389bcea536f3f9e25b6d), [`adc5fab`](https://github.com/LTplus-AG/ifc-lite/commit/adc5fab7fe9208019dccf890589fb5fa5637ea63), [`ce8ca9f`](https://github.com/LTplus-AG/ifc-lite/commit/ce8ca9f3b8fd51ed89a9c21a275f00d63c240875), [`4f5414d`](https://github.com/LTplus-AG/ifc-lite/commit/4f5414d7faf69b2ca8a624edf20f6d6b0b448cac), [`a1aebc8`](https://github.com/LTplus-AG/ifc-lite/commit/a1aebc822b819221258f4759edf4c82ff0d140f7), [`a21f271`](https://github.com/LTplus-AG/ifc-lite/commit/a21f2718e93cd6bb432591ab006a9ecbb0cb648d), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`9368b2d`](https://github.com/LTplus-AG/ifc-lite/commit/9368b2dcdc8df61afe790e671de95317e0418c21), [`2c84b15`](https://github.com/LTplus-AG/ifc-lite/commit/2c84b15526456ad57ba93a77f669208174efbed3), [`4b043d4`](https://github.com/LTplus-AG/ifc-lite/commit/4b043d4e77345e77532c328ddd62d58c39b6bbe8), [`3cd1647`](https://github.com/LTplus-AG/ifc-lite/commit/3cd1647a2918ac27b903cb82bc797c2d2b288ac3), [`a1069f8`](https://github.com/LTplus-AG/ifc-lite/commit/a1069f8f096fcfc5771200a2748466096c3463d5), [`bcd716a`](https://github.com/LTplus-AG/ifc-lite/commit/bcd716a0bd5291b431b5d52c0910be47685224d6), [`9bc0dd9`](https://github.com/LTplus-AG/ifc-lite/commit/9bc0dd952b93982eafe1fbe7a9a483d4c3557b61), [`afb9725`](https://github.com/LTplus-AG/ifc-lite/commit/afb972525bb99e3056ccaa84ee7a78e0c7de81ef), [`dc8198c`](https://github.com/LTplus-AG/ifc-lite/commit/dc8198ce3f9b9be4b2420dce90343822e0079465), [`8b975fe`](https://github.com/LTplus-AG/ifc-lite/commit/8b975fec2769ba8f1787075ecb7785bb3bc06ac0), [`b331b49`](https://github.com/LTplus-AG/ifc-lite/commit/b331b4921ff0927ee18bb78f00d2bb6e496219d8), [`ae3efa1`](https://github.com/LTplus-AG/ifc-lite/commit/ae3efa1f09dd9e16de2d34c51665532a8dfde3f1), [`cfee55b`](https://github.com/LTplus-AG/ifc-lite/commit/cfee55b287075eddbe10cc37d4c0d70caaac7279), [`1389598`](https://github.com/LTplus-AG/ifc-lite/commit/1389598ac7e8c4986a89b50d7671cbb5028ab066), [`de3c82d`](https://github.com/LTplus-AG/ifc-lite/commit/de3c82d03047737fc4b870477b2cc0b61ffc56dc), [`cb9dad2`](https://github.com/LTplus-AG/ifc-lite/commit/cb9dad2df38f1796ab8cb6eefe881ad795876cc9), [`0b13e2d`](https://github.com/LTplus-AG/ifc-lite/commit/0b13e2d89b51608c2be3425ba2e5c95bfb8c0e5e), [`c4dafbf`](https://github.com/LTplus-AG/ifc-lite/commit/c4dafbf418810c519d49d5739bfedb2da41651b0), [`c65ec91`](https://github.com/LTplus-AG/ifc-lite/commit/c65ec91b411754b73c6317455873f771a15ba9f7), [`c3bdc8f`](https://github.com/LTplus-AG/ifc-lite/commit/c3bdc8fe55536a9b27adaa7ed92fb214c975fe2e), [`c3bdc8f`](https://github.com/LTplus-AG/ifc-lite/commit/c3bdc8fe55536a9b27adaa7ed92fb214c975fe2e), [`1060a30`](https://github.com/LTplus-AG/ifc-lite/commit/1060a30187c8f6bb327f9e356056f2364568e8ff), [`3460785`](https://github.com/LTplus-AG/ifc-lite/commit/3460785652f251f3161aa8dd6f1d247750df2715), [`80a0cd9`](https://github.com/LTplus-AG/ifc-lite/commit/80a0cd9b946a5ff1aa6ca214ddb427a5d1f5303c), [`a2488e8`](https://github.com/LTplus-AG/ifc-lite/commit/a2488e858bc7792cdcc818f7759c0a6e46e7d892), [`b135862`](https://github.com/LTplus-AG/ifc-lite/commit/b1358623210867daba42ff56e97ff05733bff646), [`4bdab03`](https://github.com/LTplus-AG/ifc-lite/commit/4bdab03efb71f878f307ceb3767beb83d8c8b0f6), [`d401b85`](https://github.com/LTplus-AG/ifc-lite/commit/d401b85a59b30a4223e291f6388800499a47954b), [`d401b85`](https://github.com/LTplus-AG/ifc-lite/commit/d401b85a59b30a4223e291f6388800499a47954b), [`8368339`](https://github.com/LTplus-AG/ifc-lite/commit/83683393654d8c1b903f03b5c6e9e5ff111fdaf0), [`ececb25`](https://github.com/LTplus-AG/ifc-lite/commit/ececb25f4e70e1086a274c7651512ccc60b23205), [`e5b8dbc`](https://github.com/LTplus-AG/ifc-lite/commit/e5b8dbc7e037aa049d56b1fb3bd1b55c034f9114), [`2edd144`](https://github.com/LTplus-AG/ifc-lite/commit/2edd14432999ceeed4c0bb0baf6b2000c1c5b041), [`cd6f54f`](https://github.com/LTplus-AG/ifc-lite/commit/cd6f54f48e0c3d9013d13f1b9a95d495287b3b45), [`2a2c73f`](https://github.com/LTplus-AG/ifc-lite/commit/2a2c73fc95044c5e6823f0dbc55f5e2c7a87a948), [`f8e03d4`](https://github.com/LTplus-AG/ifc-lite/commit/f8e03d4d5bb620fc9e807d5233091d145a201165), [`f76b3a1`](https://github.com/LTplus-AG/ifc-lite/commit/f76b3a1fe729acbf8fea40766ba8d068721f09df), [`3ccb417`](https://github.com/LTplus-AG/ifc-lite/commit/3ccb4176f3a61a227bcfc302c3e0b1fb43a6f0ec), [`7eaed2a`](https://github.com/LTplus-AG/ifc-lite/commit/7eaed2a98a8cd60bd402c0a9d79940739eabb331), [`2213431`](https://github.com/LTplus-AG/ifc-lite/commit/22134312e50d7f2dbe5d45928740eef5f6ffa241), [`499ccf2`](https://github.com/LTplus-AG/ifc-lite/commit/499ccf2f97fe1e24728eb4eb99f895044c36f7b2), [`4475e58`](https://github.com/LTplus-AG/ifc-lite/commit/4475e583ea35def444fb6d7ba92410629bd89096), [`80a0cd9`](https://github.com/LTplus-AG/ifc-lite/commit/80a0cd9b946a5ff1aa6ca214ddb427a5d1f5303c), [`a99ecd9`](https://github.com/LTplus-AG/ifc-lite/commit/a99ecd9998dada941dc66e8bcc85ce3864b44065), [`cfee9b2`](https://github.com/LTplus-AG/ifc-lite/commit/cfee9b28f5e6bec2040a29cbf7917be4696f407e), [`1b54404`](https://github.com/LTplus-AG/ifc-lite/commit/1b54404039bf2973732795cb219dcfd6a631b9e6), [`ff292b6`](https://github.com/LTplus-AG/ifc-lite/commit/ff292b685a7c663ef3e79928a754667bb919066a), [`2b87396`](https://github.com/LTplus-AG/ifc-lite/commit/2b87396553df0f3c11a930e3dae8b8600d70a23f)]:
  - @ifc-lite/export@4.0.0
  - @ifc-lite/parser@5.0.0
  - @ifc-lite/bcf@3.0.0
  - @ifc-lite/renderer@2.0.0
  - @ifc-lite/encoding@2.2.0
  - @ifc-lite/clash@2.0.0
  - @ifc-lite/wasm@6.2.0
  - @ifc-lite/sandbox@2.2.2
  - @ifc-lite/sdk@4.0.0
  - @ifc-lite/cache@3.2.0
  - @ifc-lite/collab@0.6.1
  - @ifc-lite/data@4.0.0
  - @ifc-lite/create@2.2.1
  - @ifc-lite/mutations@2.0.0
  - @ifc-lite/diff@0.8.0
  - @ifc-lite/mcp@0.13.0
  - @ifc-lite/query@2.1.0
  - @ifc-lite/drawing-2d@4.0.0
  - @ifc-lite/pointcloud@0.7.2
  - @ifc-lite/embed-protocol@1.15.0
  - @ifc-lite/geometry@4.2.0
  - @ifc-lite/spatial@1.14.16
  - @ifc-lite/server-client@2.0.0
  - @ifc-lite/ids@1.15.53
  - @ifc-lite/ifcx@4.0.0
  - @ifc-lite/extensions@0.6.0
  - @ifc-lite/lens@1.19.1
  - @ifc-lite/lists@2.1.0
  - @ifc-lite/merge@0.4.5

## 1.14.20

### Patch Changes

- Updated dependencies [[`93b450c`](https://github.com/LTplus-AG/ifc-lite/commit/93b450c1cc0c3cee811625989edb82cf522c70c4), [`ddf9f1d`](https://github.com/LTplus-AG/ifc-lite/commit/ddf9f1da830cef5f941ea09e8aee19624e9def3a), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`e19aa0e`](https://github.com/LTplus-AG/ifc-lite/commit/e19aa0ef271eccc7f2f6862b8580e9f98dbd1a66), [`66697fc`](https://github.com/LTplus-AG/ifc-lite/commit/66697fc57de1de4475a2c5eed4361e0e378e0f7a), [`447f02e`](https://github.com/LTplus-AG/ifc-lite/commit/447f02eefc2933c63c03aea6c7793343df20fcd7), [`0ea7167`](https://github.com/LTplus-AG/ifc-lite/commit/0ea7167a6bd96d5b5e12e7e5a8c5615ab0b7c3b2), [`228bbe7`](https://github.com/LTplus-AG/ifc-lite/commit/228bbe730522148ea797780c5acd08502b18a3a3), [`3bef19b`](https://github.com/LTplus-AG/ifc-lite/commit/3bef19b13d303029b87e862660e3730c06852687), [`e6caf11`](https://github.com/LTplus-AG/ifc-lite/commit/e6caf11a8f8d9d8634a6811b6705ab3367cd02e0), [`2580830`](https://github.com/LTplus-AG/ifc-lite/commit/25808308bbbc63eb0fd8b25e6dd0c08864adb6a8), [`b25b2e7`](https://github.com/LTplus-AG/ifc-lite/commit/b25b2e7387bd365fda02d48095266f16b4f05cd7), [`7ff31ba`](https://github.com/LTplus-AG/ifc-lite/commit/7ff31ba854671a9ca3ebbf30b15e928e1b52a8b9), [`8ba612f`](https://github.com/LTplus-AG/ifc-lite/commit/8ba612f90d3bb0ad41f756d6fdef6b3250e8d330), [`9359bc4`](https://github.com/LTplus-AG/ifc-lite/commit/9359bc488173585b2b90e124cc66dcf8292c4be9), [`8571d70`](https://github.com/LTplus-AG/ifc-lite/commit/8571d70270d072170fc4e204e8b0d11a424d2330), [`65d19dd`](https://github.com/LTplus-AG/ifc-lite/commit/65d19ddd305b00dd6cdd8a815e3e9749dee5949b), [`b1d7a4d`](https://github.com/LTplus-AG/ifc-lite/commit/b1d7a4d832557e6961aef82102f423b07742c385), [`f64ecdc`](https://github.com/LTplus-AG/ifc-lite/commit/f64ecdc2129074d2d3def676d6ddd69dffdd785e), [`f6febcc`](https://github.com/LTplus-AG/ifc-lite/commit/f6febcc2d4986e79b3c44d63853bb72a16475c65), [`5781e5c`](https://github.com/LTplus-AG/ifc-lite/commit/5781e5c2998111926683419d27f8efa3519de7c6), [`bc2e5e5`](https://github.com/LTplus-AG/ifc-lite/commit/bc2e5e56d7324f605b15b6e6f939849859a5d0ad), [`1118399`](https://github.com/LTplus-AG/ifc-lite/commit/11183991d9fb042221d20f1ca432dc0b2293c928), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`063a140`](https://github.com/LTplus-AG/ifc-lite/commit/063a1408e4c54ebc874618f8d68fe298ed3f3a6f), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`f76c805`](https://github.com/LTplus-AG/ifc-lite/commit/f76c80511dce5ffc1756365b786042c4bc64808d), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`4a8fe77`](https://github.com/LTplus-AG/ifc-lite/commit/4a8fe77707127d251702610490f53430610e4ef7), [`f135c02`](https://github.com/LTplus-AG/ifc-lite/commit/f135c02624b8a7aa1915068405545d108f55fce4), [`ffcc9e6`](https://github.com/LTplus-AG/ifc-lite/commit/ffcc9e6f048cd263a5b70946417c9b6aceec1bec), [`4a8fe77`](https://github.com/LTplus-AG/ifc-lite/commit/4a8fe77707127d251702610490f53430610e4ef7), [`f7e26e4`](https://github.com/LTplus-AG/ifc-lite/commit/f7e26e4200e1475728d4976142b49cb408400a8e), [`0146f0a`](https://github.com/LTplus-AG/ifc-lite/commit/0146f0a3b2ed36313f7f91236bcc95587cdcc8d3), [`f449776`](https://github.com/LTplus-AG/ifc-lite/commit/f4497765cb4e17828ff6ca6b52fb8a96caa2f81f), [`40cd43c`](https://github.com/LTplus-AG/ifc-lite/commit/40cd43ce29cce6c71671e07abde00b41c8886e37), [`56ad58c`](https://github.com/LTplus-AG/ifc-lite/commit/56ad58cc8d1d8d54fdb996606f667c0c170d74aa), [`8b9bc5a`](https://github.com/LTplus-AG/ifc-lite/commit/8b9bc5a0b2d6541f6a0ec45c10e41b005059e06b), [`dec0708`](https://github.com/LTplus-AG/ifc-lite/commit/dec0708ef841c88abea6ec91404419fd7a3d93c6), [`dec0708`](https://github.com/LTplus-AG/ifc-lite/commit/dec0708ef841c88abea6ec91404419fd7a3d93c6), [`dec0708`](https://github.com/LTplus-AG/ifc-lite/commit/dec0708ef841c88abea6ec91404419fd7a3d93c6), [`5ea5f99`](https://github.com/LTplus-AG/ifc-lite/commit/5ea5f9969f3a4a3f8b21eb2a90a1df2be48eb7b0), [`412f78c`](https://github.com/LTplus-AG/ifc-lite/commit/412f78c1bf4907f8c230fc149bbb00e0711b6689), [`487866d`](https://github.com/LTplus-AG/ifc-lite/commit/487866dac131bf50a0b3008ddce5db933768dca2), [`932f043`](https://github.com/LTplus-AG/ifc-lite/commit/932f0439fc1625419aae3cf2d9f81a614fb2273c), [`f1ee3e8`](https://github.com/LTplus-AG/ifc-lite/commit/f1ee3e88889281af34f0e382cef7ea57ee9d47c1), [`754837b`](https://github.com/LTplus-AG/ifc-lite/commit/754837b066172dad8afcdf1a0104f1a021b5f6e5), [`2273a73`](https://github.com/LTplus-AG/ifc-lite/commit/2273a73127d03ec36d667544da6237479737881a), [`20264d8`](https://github.com/LTplus-AG/ifc-lite/commit/20264d8b1ee82169a02f9dc588decc45fb8fdc00), [`5ea5f99`](https://github.com/LTplus-AG/ifc-lite/commit/5ea5f9969f3a4a3f8b21eb2a90a1df2be48eb7b0), [`131e3dc`](https://github.com/LTplus-AG/ifc-lite/commit/131e3dc84244d9dd24859a5923ef0aef4d6119c4), [`a8587cc`](https://github.com/LTplus-AG/ifc-lite/commit/a8587cc21c309ebd6c87119cb0d1cd6d1005c281), [`b1f4335`](https://github.com/LTplus-AG/ifc-lite/commit/b1f4335f3bf3c379f4a2afa4f96e5fe1fc3bc97d), [`945c4d7`](https://github.com/LTplus-AG/ifc-lite/commit/945c4d7a773614dd664feb9490e13372782a543b), [`fdd6121`](https://github.com/LTplus-AG/ifc-lite/commit/fdd61211e41d3e563a7604ac5e0630a9daae2de1), [`50d9f91`](https://github.com/LTplus-AG/ifc-lite/commit/50d9f91af0b49c2b503e5cf8abd0aa83adfd8c34), [`6e51909`](https://github.com/LTplus-AG/ifc-lite/commit/6e519094bb69dff4c550c383bbc89b889a5fcafa), [`409520e`](https://github.com/LTplus-AG/ifc-lite/commit/409520ee2e940866b126c3433cc10d0fe110d645), [`6095fe0`](https://github.com/LTplus-AG/ifc-lite/commit/6095fe0c19072e9a97edefb2be95dde66f514f6b), [`b59c520`](https://github.com/LTplus-AG/ifc-lite/commit/b59c5206a154728139d1307bf823e5c5d7c4786a), [`be74930`](https://github.com/LTplus-AG/ifc-lite/commit/be74930b383a189ac61c5f8ef5bc8b5f4579dda3), [`be74930`](https://github.com/LTplus-AG/ifc-lite/commit/be74930b383a189ac61c5f8ef5bc8b5f4579dda3), [`870ec9e`](https://github.com/LTplus-AG/ifc-lite/commit/870ec9ee9a35f798196c59ce82e65e210eddd429), [`00f6e79`](https://github.com/LTplus-AG/ifc-lite/commit/00f6e79c22641ff59bfb3327d910b04f9a164d8b), [`116a3e9`](https://github.com/LTplus-AG/ifc-lite/commit/116a3e94de753b95fa94b2d6c41a0171cd254729), [`75867a7`](https://github.com/LTplus-AG/ifc-lite/commit/75867a7e6ebf51b2da47cab14242bcd71787ba3b), [`1823d70`](https://github.com/LTplus-AG/ifc-lite/commit/1823d70a581429fb6a7df2272b31d426e0cf2149), [`c7c8207`](https://github.com/LTplus-AG/ifc-lite/commit/c7c820772ccdf99ecf45032b714b80249fbbc767), [`78d85dc`](https://github.com/LTplus-AG/ifc-lite/commit/78d85dcd4c59ee5b3b3b7857a454113c4911bc36), [`147693a`](https://github.com/LTplus-AG/ifc-lite/commit/147693a7a8fd0778ddb71839199b75bf1d622327), [`bea50bd`](https://github.com/LTplus-AG/ifc-lite/commit/bea50bd7bca7fdf69f01076ebb96a31b8e797a46), [`af48854`](https://github.com/LTplus-AG/ifc-lite/commit/af488542a19a8559065cfd450d0eaad5ba2f7489), [`3969c52`](https://github.com/LTplus-AG/ifc-lite/commit/3969c523063d02e501f421e6b42d1a9a516dc2e4), [`bb734da`](https://github.com/LTplus-AG/ifc-lite/commit/bb734da27afbea4b6e595714950cdb195cddeb1f), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`74a55a9`](https://github.com/LTplus-AG/ifc-lite/commit/74a55a999117b4e21aa58d0435473073f35c1e81), [`00f6e79`](https://github.com/LTplus-AG/ifc-lite/commit/00f6e79c22641ff59bfb3327d910b04f9a164d8b), [`e43582b`](https://github.com/LTplus-AG/ifc-lite/commit/e43582b069007c6c2c932f6981743a80630fe217), [`043e06a`](https://github.com/LTplus-AG/ifc-lite/commit/043e06a05c6625fef91bb17d84e3a3447f1379e3)]:
  - @ifc-lite/bcf@2.0.0
  - @ifc-lite/parser@4.3.0
  - @ifc-lite/mcp@0.12.0
  - @ifc-lite/collab@0.6.0
  - @ifc-lite/extensions@0.5.0
  - @ifc-lite/wasm@6.0.0
  - @ifc-lite/cache@3.0.6
  - @ifc-lite/ifcx@3.0.0
  - @ifc-lite/merge@0.4.4
  - @ifc-lite/export@3.0.0
  - @ifc-lite/sdk@3.0.0
  - @ifc-lite/encoding@2.1.0
  - @ifc-lite/lists@2.0.0
  - @ifc-lite/data@3.4.1
  - @ifc-lite/drawing-2d@3.0.0
  - @ifc-lite/renderer@1.50.0
  - @ifc-lite/geometry@4.0.0
  - @ifc-lite/embed-protocol@1.14.8
  - @ifc-lite/query@2.0.0
  - @ifc-lite/ids@1.15.49
  - @ifc-lite/lens@1.19.0
  - @ifc-lite/clash@1.9.1
  - @ifc-lite/mutations@1.27.0
  - @ifc-lite/pointcloud@0.7.1
  - @ifc-lite/sandbox@2.2.1
  - @ifc-lite/create@2.2.0
  - @ifc-lite/server-client@1.23.0
  - @ifc-lite/spatial@1.14.15

## 1.14.19

### Patch Changes

- [#2788](https://github.com/LTplus-AG/ifc-lite/pull/2788) [`783eb3e`](https://github.com/LTplus-AG/ifc-lite/commit/783eb3e04558a86ae7e1ffc6754642e9a0abb449) Thanks [@BIMvoice](https://github.com/BIMvoice)! - Fix the embed viewer never emitting the `SECTION_CHANGED` event.
  
  `SECTION_CHANGED` is a declared `OutboundEventType` (`@ifc-lite/embed-protocol`)
  that `@ifc-lite/embed-sdk` exposes to host pages as the `'section-changed'`
  event, but nothing in the viewer ever posted it: the `SET_SECTION` bridge
  command handler mutated the section-plane store and replied with `RESPONSE`,
  and stopped there.
  
  `EmbedViewer.tsx` now subscribes to the section-plane store slice and emits
  `SECTION_CHANGED` reactively, the same pattern `CAMERA_CHANGED` and
  `ENTITY_SELECTED` already use for `SET_CAMERA`/`SELECT` (so the event also
  fires for section changes made through the in-viewer section tool, not only
  through `SET_SECTION`). The payload matches `OutboundPayloads.SECTION_CHANGED`
  exactly (`axis`, `position`, `enabled` -- `flipped` is not part of the
  declared shape, so it is not invented here).
- Updated dependencies [[`b9faf82`](https://github.com/LTplus-AG/ifc-lite/commit/b9faf8296f86943914c30550af8131fee250d4c8), [`8f89331`](https://github.com/LTplus-AG/ifc-lite/commit/8f893311b170a983e160737bd9479c3caf961911), [`bc179f6`](https://github.com/LTplus-AG/ifc-lite/commit/bc179f6a1091c8c307a07b31d8c30fbba140e4a9), [`b9faf82`](https://github.com/LTplus-AG/ifc-lite/commit/b9faf8296f86943914c30550af8131fee250d4c8), [`48b204b`](https://github.com/LTplus-AG/ifc-lite/commit/48b204b868016aad29b694b53ac8ace5e76a0542), [`b14e710`](https://github.com/LTplus-AG/ifc-lite/commit/b14e710ae8d56f518f84abb4d4ec8d1f98aacad8), [`05592f8`](https://github.com/LTplus-AG/ifc-lite/commit/05592f8c1ef5b34a00c2ea077542dc68107a7ae5), [`7b3617f`](https://github.com/LTplus-AG/ifc-lite/commit/7b3617f2ec9a6e9e8a57127d2ec61f9c33cadf3a), [`432fdb8`](https://github.com/LTplus-AG/ifc-lite/commit/432fdb8dd12dd90af17d1ca3ce24a2fd5b7168b0), [`6a43522`](https://github.com/LTplus-AG/ifc-lite/commit/6a43522cdf3b0a9b0f7ce303b59f479dca2a2aca), [`b699875`](https://github.com/LTplus-AG/ifc-lite/commit/b6998754039676def950735335147556afcb2977), [`b3a4d30`](https://github.com/LTplus-AG/ifc-lite/commit/b3a4d307c50c9b0a8b8bb0e29952c4a98e417c16), [`0a10389`](https://github.com/LTplus-AG/ifc-lite/commit/0a1038972a72b27bda99c8793055efe39d623f10), [`5334bd1`](https://github.com/LTplus-AG/ifc-lite/commit/5334bd1589acb1c4b81a1f255d1a9171530b1467), [`b1ac6be`](https://github.com/LTplus-AG/ifc-lite/commit/b1ac6be425cd89ff90eaab02636211f0d928b3e6), [`c688a12`](https://github.com/LTplus-AG/ifc-lite/commit/c688a1272ec72d575e8ecf78072e0a0084b517ca), [`4ce3879`](https://github.com/LTplus-AG/ifc-lite/commit/4ce38798211b6b5f84e5b21ed335aa80fe1514c4), [`79322b6`](https://github.com/LTplus-AG/ifc-lite/commit/79322b6e76049be0df3b07149c711414bd80863e), [`3329521`](https://github.com/LTplus-AG/ifc-lite/commit/33295218a3a2ecd35671483bc92bbf018807ae1e), [`2156528`](https://github.com/LTplus-AG/ifc-lite/commit/2156528c926114233c79ba74925c0c8656f1ea65), [`7869a90`](https://github.com/LTplus-AG/ifc-lite/commit/7869a90f35384ceba40b7ce4f3e9fadbe6990fa8), [`be6b43c`](https://github.com/LTplus-AG/ifc-lite/commit/be6b43c2b334811422c1cbfbea5d6e6d1b9a401d), [`989ee2c`](https://github.com/LTplus-AG/ifc-lite/commit/989ee2c4e396575529488c17b73e1a884e4e8b9d), [`1cda2d0`](https://github.com/LTplus-AG/ifc-lite/commit/1cda2d04dc66542892dd0181768c027b3d1b4e6f), [`0ed2582`](https://github.com/LTplus-AG/ifc-lite/commit/0ed2582b71973fa6d16307999ed2ea59f7a2db3f), [`b4740a1`](https://github.com/LTplus-AG/ifc-lite/commit/b4740a1fb18050c065e8fbd58714626bdf852f00), [`5a9ecfb`](https://github.com/LTplus-AG/ifc-lite/commit/5a9ecfb6bcd3190eae4463bd8926cf38a2143496), [`9fb50eb`](https://github.com/LTplus-AG/ifc-lite/commit/9fb50ebcfaaf2926b2badd4d4d8dfc6ca55b762f), [`969cff9`](https://github.com/LTplus-AG/ifc-lite/commit/969cff95a77ce4c17a949a93632c8a0378fd3ede), [`a29b040`](https://github.com/LTplus-AG/ifc-lite/commit/a29b04069fec3c6b726f49fc58054e535c255034), [`cc19a8d`](https://github.com/LTplus-AG/ifc-lite/commit/cc19a8d4a79a5e8563a90ab663b28e1b93ef9c18), [`36e4eca`](https://github.com/LTplus-AG/ifc-lite/commit/36e4eca3b19a2fe02f1679acc9a2a43cd90aa163), [`a7b8a20`](https://github.com/LTplus-AG/ifc-lite/commit/a7b8a201eaecd411a4246421893e887bf55aafd3), [`ad50aa9`](https://github.com/LTplus-AG/ifc-lite/commit/ad50aa9751c31f6895944e26ce19fe8cbbf3018e), [`ccc38b0`](https://github.com/LTplus-AG/ifc-lite/commit/ccc38b0de9925a3de1106893a5785117e0e7551d), [`105eb31`](https://github.com/LTplus-AG/ifc-lite/commit/105eb31e7ccdd697f74db3bc9fac41396cdc6faa), [`4f01d5c`](https://github.com/LTplus-AG/ifc-lite/commit/4f01d5caf469c380c5e1a15d807a5ebb7f6de86e), [`679c7cb`](https://github.com/LTplus-AG/ifc-lite/commit/679c7cb680ab0d8f17e8f5c267fdb424049ec0d0), [`ae14cd3`](https://github.com/LTplus-AG/ifc-lite/commit/ae14cd3036f11c039d9b7cd786acf51a68b884dc), [`8226c0a`](https://github.com/LTplus-AG/ifc-lite/commit/8226c0aae9c4ca641b970873c0a0adf648429205), [`2edf1c6`](https://github.com/LTplus-AG/ifc-lite/commit/2edf1c60023832a7a9a3629e9d5aaa40e4be1e35), [`f31822b`](https://github.com/LTplus-AG/ifc-lite/commit/f31822b0833e1bcd76c43736daf1d76cb3e59914), [`4d1c611`](https://github.com/LTplus-AG/ifc-lite/commit/4d1c611b822e80a6123b040887a31cdb43c460da), [`5660d53`](https://github.com/LTplus-AG/ifc-lite/commit/5660d53f5326188c474bb0c31d3e1ff6b104426c), [`5254699`](https://github.com/LTplus-AG/ifc-lite/commit/52546994268440a468de81ce6ac0b385e6ef73d7), [`c233d48`](https://github.com/LTplus-AG/ifc-lite/commit/c233d48a935a70851271b61a305f43dd9261dcca), [`b28a629`](https://github.com/LTplus-AG/ifc-lite/commit/b28a629d49f279ce01537cb06ae4c28f32beb2bb), [`1900a1a`](https://github.com/LTplus-AG/ifc-lite/commit/1900a1a9f8174ef874dddbd1541ccadd9a89415e), [`6ce17fa`](https://github.com/LTplus-AG/ifc-lite/commit/6ce17fa903d38ab8ee3e6ebaf6da8453726d3ce2), [`b7d2a11`](https://github.com/LTplus-AG/ifc-lite/commit/b7d2a11345add8acdf0926ade5d4c1ca19ccecf7), [`c849b13`](https://github.com/LTplus-AG/ifc-lite/commit/c849b1395511e48ed6c8b6bd01bc0b1a66d60bfa), [`7862e92`](https://github.com/LTplus-AG/ifc-lite/commit/7862e929e7b8644c9df6a87f90f151901d33fc77), [`5d68a13`](https://github.com/LTplus-AG/ifc-lite/commit/5d68a13f7e2ed9c9754242b624abfa7343888f14), [`7862c03`](https://github.com/LTplus-AG/ifc-lite/commit/7862c0360c7297c0b24f100b62c55abc8e612b75), [`ae5a5ca`](https://github.com/LTplus-AG/ifc-lite/commit/ae5a5caa3e20304085ba14c0708cd026c1d4bf16), [`adc37ca`](https://github.com/LTplus-AG/ifc-lite/commit/adc37cac288e53be88796fddf06b0a7ae179f451), [`2affb53`](https://github.com/LTplus-AG/ifc-lite/commit/2affb534e8ed7b339dc52984789638d4ea4774bc), [`adc37ca`](https://github.com/LTplus-AG/ifc-lite/commit/adc37cac288e53be88796fddf06b0a7ae179f451), [`f19206b`](https://github.com/LTplus-AG/ifc-lite/commit/f19206b8912ba418627373e147c1699019450ebf), [`c49c7f6`](https://github.com/LTplus-AG/ifc-lite/commit/c49c7f644cd7930bd3937ed850f3864aa516934b)]:
  - @ifc-lite/bcf@1.18.2
  - @ifc-lite/collab@0.5.0
  - @ifc-lite/mutations@1.26.1
  - @ifc-lite/cache@3.0.5
  - @ifc-lite/clash@1.9.0
  - @ifc-lite/geometry@3.8.4
  - @ifc-lite/parser@4.2.0
  - @ifc-lite/drawing-2d@2.1.1
  - @ifc-lite/query@1.14.17
  - @ifc-lite/data@3.4.0
  - @ifc-lite/wasm@5.0.0
  - @ifc-lite/ids@1.15.48
  - @ifc-lite/create@2.1.2
  - @ifc-lite/ifcx@2.3.7
  - @ifc-lite/lens@1.18.1
  - @ifc-lite/sdk@2.1.3
  - @ifc-lite/export@2.9.4
  - @ifc-lite/mcp@0.11.3
  - @ifc-lite/merge@0.4.3
  - @ifc-lite/renderer@1.49.1
  - @ifc-lite/server-client@1.22.2
  - @ifc-lite/solar@1.15.5
  - @ifc-lite/spatial@1.14.14
  - @ifc-lite/lists@1.23.2

## 1.14.18

### Patch Changes

- Updated dependencies [[`7f2d9cf`](https://github.com/LTplus-AG/ifc-lite/commit/7f2d9cf1fdcf8facd9bf3f1445ddf3c665206b76), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`85ae89d`](https://github.com/LTplus-AG/ifc-lite/commit/85ae89d915937be21dde174db6a123e883189be6), [`8324512`](https://github.com/LTplus-AG/ifc-lite/commit/8324512daee39a018056aa88a148f72791db89c4), [`5cf117d`](https://github.com/LTplus-AG/ifc-lite/commit/5cf117d1eb16dba7f3e7be67114e26ce3ec44a8f), [`5cf117d`](https://github.com/LTplus-AG/ifc-lite/commit/5cf117d1eb16dba7f3e7be67114e26ce3ec44a8f), [`5cf117d`](https://github.com/LTplus-AG/ifc-lite/commit/5cf117d1eb16dba7f3e7be67114e26ce3ec44a8f), [`a351839`](https://github.com/LTplus-AG/ifc-lite/commit/a35183910da35bd44dd38c5ed50d49d5f73b9f4a), [`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599), [`307693c`](https://github.com/LTplus-AG/ifc-lite/commit/307693c678d525ab007773f74e13a308bfe63b34), [`7cb7394`](https://github.com/LTplus-AG/ifc-lite/commit/7cb73940e0c23cd6b93c4483bfddb7b45cbb363a), [`649aa0c`](https://github.com/LTplus-AG/ifc-lite/commit/649aa0ccbc4e67c233b9175a6a2f9c8e1ff310ec), [`004b2ff`](https://github.com/LTplus-AG/ifc-lite/commit/004b2ff636fc0299ff669d14e6fbe1ed97881e21), [`004b2ff`](https://github.com/LTplus-AG/ifc-lite/commit/004b2ff636fc0299ff669d14e6fbe1ed97881e21), [`fffc0ee`](https://github.com/LTplus-AG/ifc-lite/commit/fffc0ee91c0c7c63955993faf470fa0581303005), [`2d87b39`](https://github.com/LTplus-AG/ifc-lite/commit/2d87b3919c0ca5afff03e205c5f598142bbc980d), [`2bd854d`](https://github.com/LTplus-AG/ifc-lite/commit/2bd854de15965b0fee684ef6fda90f2984d3e6f0), [`fffc0ee`](https://github.com/LTplus-AG/ifc-lite/commit/fffc0ee91c0c7c63955993faf470fa0581303005), [`5086c57`](https://github.com/LTplus-AG/ifc-lite/commit/5086c5729b6ae8ad967aafa91d96dfdb37327599), [`7cd8193`](https://github.com/LTplus-AG/ifc-lite/commit/7cd81939ed4acf9e93686d1d96dddcf7606fb59a)]:
  - @ifc-lite/clash@1.7.0
  - @ifc-lite/parser@4.1.0
  - @ifc-lite/wasm@4.6.0
  - @ifc-lite/renderer@1.48.0
  - @ifc-lite/drawing-2d@2.0.0
  - @ifc-lite/geometry@3.8.3
  - @ifc-lite/lens@1.18.0
  - @ifc-lite/pointcloud@0.7.0
  - @ifc-lite/solar@1.15.4
  - @ifc-lite/diff@0.7.0
  - @ifc-lite/export@2.9.2
  - @ifc-lite/ids@1.15.47
  - @ifc-lite/sdk@2.1.2
  - @ifc-lite/ifcx@2.3.6
  - @ifc-lite/mcp@0.11.2
  - @ifc-lite/merge@0.4.2

## 1.14.17

### Patch Changes

- Updated dependencies [[`2e18adc`](https://github.com/LTplus-AG/ifc-lite/commit/2e18adc0e6983dbd5832367429cc3782e2cb2d1e), [`2e18adc`](https://github.com/LTplus-AG/ifc-lite/commit/2e18adc0e6983dbd5832367429cc3782e2cb2d1e), [`2e18adc`](https://github.com/LTplus-AG/ifc-lite/commit/2e18adc0e6983dbd5832367429cc3782e2cb2d1e), [`0ab480d`](https://github.com/LTplus-AG/ifc-lite/commit/0ab480dd78fbce9f8159b6248579356cfa25bfaa), [`7ee619f`](https://github.com/LTplus-AG/ifc-lite/commit/7ee619f8c6a7490982136d5677674f4f6355a568), [`bb0c1fe`](https://github.com/LTplus-AG/ifc-lite/commit/bb0c1feab74d0e4b76b66acbabf7bebe45144b25), [`1e13943`](https://github.com/LTplus-AG/ifc-lite/commit/1e139434adac8e98e6e40c989b257e5ec87aa20a), [`b4b3e0c`](https://github.com/LTplus-AG/ifc-lite/commit/b4b3e0cfa8ffa9185e96dc266dd6fdc3fef34797), [`7ec9876`](https://github.com/LTplus-AG/ifc-lite/commit/7ec9876202b3fd4d83fda5f23931740a6b0e4e25), [`c532d6a`](https://github.com/LTplus-AG/ifc-lite/commit/c532d6a9cb9397a24e718bcfe09f1c515067852d), [`1de1696`](https://github.com/LTplus-AG/ifc-lite/commit/1de16969db1c56f4901e4af49da74085bae3b3fe), [`ed9acf0`](https://github.com/LTplus-AG/ifc-lite/commit/ed9acf0d5a11c291caa70165e9d673812c75c7fa)]:
  - @ifc-lite/cache@3.0.4
  - @ifc-lite/geometry@3.8.1
  - @ifc-lite/parser@4.0.2
  - @ifc-lite/renderer@1.44.1
  - @ifc-lite/server-client@1.22.1
  - @ifc-lite/encoding@2.0.0
  - @ifc-lite/lists@1.23.0
  - @ifc-lite/ids@1.15.44
  - @ifc-lite/bcf@1.18.1
  - @ifc-lite/create@2.0.3
  - @ifc-lite/data@3.2.4
  - @ifc-lite/export@2.8.5
  - @ifc-lite/sdk@2.1.1

## 1.14.16

### Patch Changes

- Updated dependencies [[`1843d9f`](https://github.com/LTplus-AG/ifc-lite/commit/1843d9f13a7a10183f780ae0a1df9dd225938e73), [`8b09cfd`](https://github.com/LTplus-AG/ifc-lite/commit/8b09cfdadafaea9806e79b73deb9119ea66b5aa4), [`a500a98`](https://github.com/LTplus-AG/ifc-lite/commit/a500a9892ef1e40a0b42db37023c07c62259abdc), [`51cd3ab`](https://github.com/LTplus-AG/ifc-lite/commit/51cd3ab46c7f9d40588e319e7b2c24ce66e99c29), [`341901f`](https://github.com/LTplus-AG/ifc-lite/commit/341901f94c7ae16cb6b2e34542ee2958f1a9ae95), [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`29409e5`](https://github.com/LTplus-AG/ifc-lite/commit/29409e57227d3c458707dbc2cf0cb2e8ae8fcf7b), [`5dd1d18`](https://github.com/LTplus-AG/ifc-lite/commit/5dd1d181437bf0d1d357f3c5505049f802beb2cf), [`6635ddf`](https://github.com/LTplus-AG/ifc-lite/commit/6635ddfa91911b0fbc489452c02cf19e232201c3), [`6f5566f`](https://github.com/LTplus-AG/ifc-lite/commit/6f5566fa761f25a02818a750351b0b0db785ef9b), [`3029cb2`](https://github.com/LTplus-AG/ifc-lite/commit/3029cb2813940438dd43de3cca9e6b25546dad80), [`70c431d`](https://github.com/LTplus-AG/ifc-lite/commit/70c431d3d9a12a5217ac0c1912da18bce7548e4e), [`55f7591`](https://github.com/LTplus-AG/ifc-lite/commit/55f759154421bd002d0bdc171e82aa93b574470d), [`d260a35`](https://github.com/LTplus-AG/ifc-lite/commit/d260a35669e379e5f465861294391c95ee48cb3d), [`d75786f`](https://github.com/LTplus-AG/ifc-lite/commit/d75786f631047d234f204289426f708f0be8674b), [`51cd3ab`](https://github.com/LTplus-AG/ifc-lite/commit/51cd3ab46c7f9d40588e319e7b2c24ce66e99c29), [`e20c520`](https://github.com/LTplus-AG/ifc-lite/commit/e20c520b0c898ecd3c418e338e3684d6f9f39fed), [`273b068`](https://github.com/LTplus-AG/ifc-lite/commit/273b06827ef1469f63c396d204474a9f2400c642), [`79781f5`](https://github.com/LTplus-AG/ifc-lite/commit/79781f57c50bbc9641516a42d0de53e5b9d89932), [`403f448`](https://github.com/LTplus-AG/ifc-lite/commit/403f4485c21b9928f16566fa482c170f230852b0), [`58fbc63`](https://github.com/LTplus-AG/ifc-lite/commit/58fbc634994742c79375830c1983508752fd78e9), [`a220406`](https://github.com/LTplus-AG/ifc-lite/commit/a2204062ba1fc555e4529896cbc82efccc7a5146), [`c866bee`](https://github.com/LTplus-AG/ifc-lite/commit/c866bee62a7d6e40b15a7de63948354cbbe049a7), [`262b9df`](https://github.com/LTplus-AG/ifc-lite/commit/262b9df485e4bfd3760f73c30d93bb518e599b72), [`d4d980b`](https://github.com/LTplus-AG/ifc-lite/commit/d4d980bc3847ae94bfb043f447cb893b43d48077), [`e47a8f0`](https://github.com/LTplus-AG/ifc-lite/commit/e47a8f0f56800af1d6cbee3d63dfe9b106c9b343), [`bf44de2`](https://github.com/LTplus-AG/ifc-lite/commit/bf44de2d8d023f22e2f4010a0c7832543221909e), [`d954df3`](https://github.com/LTplus-AG/ifc-lite/commit/d954df35ef9e01f30e0a26333381b4dd50f9e59e), [`d27d043`](https://github.com/LTplus-AG/ifc-lite/commit/d27d043c62a0243ac95c4b25d7262e96622f3e3e), [`4565cf3`](https://github.com/LTplus-AG/ifc-lite/commit/4565cf3bf8e04a289cf066a8858ded7c972c1c21), [`15f3c23`](https://github.com/LTplus-AG/ifc-lite/commit/15f3c23a417d3af29a0a8302ce68173b016c6369), [`22a1eae`](https://github.com/LTplus-AG/ifc-lite/commit/22a1eae0d2b349d9abd18c7aced0c57a2f90c03a), [`2e16736`](https://github.com/LTplus-AG/ifc-lite/commit/2e167367037fa3b5d1d2d5d26dd4fb7ac169e2f5), [`ef2accf`](https://github.com/LTplus-AG/ifc-lite/commit/ef2accf9bde98e0e5dd9fcb56a1b82d385f604ff), [`710fd83`](https://github.com/LTplus-AG/ifc-lite/commit/710fd83638b51b2e4744a1ac364827a27dc0fc73), [`d9490e6`](https://github.com/LTplus-AG/ifc-lite/commit/d9490e6e2ecacb65aea42fcaef73fd292a4c3095), [`55f7591`](https://github.com/LTplus-AG/ifc-lite/commit/55f759154421bd002d0bdc171e82aa93b574470d), [`d89960a`](https://github.com/LTplus-AG/ifc-lite/commit/d89960aaab08387fbd2307c0f238bd112c684933), [`f67c622`](https://github.com/LTplus-AG/ifc-lite/commit/f67c622147ea51f2b04b93a7b7a9b485160b3e9c), [`33f11a8`](https://github.com/LTplus-AG/ifc-lite/commit/33f11a82d34b622c9d6d2c417e9fb38a7ace816e), [`8751ba4`](https://github.com/LTplus-AG/ifc-lite/commit/8751ba41dc4d1893530b0f1db6ad0f8fa0d5d3fd), [`deb54d3`](https://github.com/LTplus-AG/ifc-lite/commit/deb54d3ff75f35c3c9206c8ea9a1e875426352c6), [`51ec81b`](https://github.com/LTplus-AG/ifc-lite/commit/51ec81b125532cd0efe4f004c7ab01f4efe55cb8), [`35e37ac`](https://github.com/LTplus-AG/ifc-lite/commit/35e37ac99ab444773bfec669cfc5cf3937443942), [`2618511`](https://github.com/LTplus-AG/ifc-lite/commit/26185118071131a995b2d6a7e9f83bf1c9d578e4), [`acdddd9`](https://github.com/LTplus-AG/ifc-lite/commit/acdddd91b205d83374e2f820fcfe17db1c9abc4d), [`641530e`](https://github.com/LTplus-AG/ifc-lite/commit/641530e73c73bda24b6dc69d3a9fd8910ee16ec8), [`858fd6b`](https://github.com/LTplus-AG/ifc-lite/commit/858fd6bb0c92140bf6c3752cdc37e705e8202425), [`c589d5a`](https://github.com/LTplus-AG/ifc-lite/commit/c589d5af185d25efc20ec56b8f97849e2a20de7e), [`6668c66`](https://github.com/LTplus-AG/ifc-lite/commit/6668c66f02542cfb31e9c9c679e0c80f9a3abc40), [`dae94e2`](https://github.com/LTplus-AG/ifc-lite/commit/dae94e23f7514945ca60f7074f50f196a90dfc5d), [`b57f04c`](https://github.com/LTplus-AG/ifc-lite/commit/b57f04c45082bad7269e7f103f361b0947435cc4), [`c777cad`](https://github.com/LTplus-AG/ifc-lite/commit/c777cadde939b4bc84b08bc0366d54d34601d66c), [`8d1972d`](https://github.com/LTplus-AG/ifc-lite/commit/8d1972d059fe5e8725fffbf661cc56bb6a23767b), [`07d5309`](https://github.com/LTplus-AG/ifc-lite/commit/07d53098b7e9099152300e705d8a41430831f81c), [`958aef1`](https://github.com/LTplus-AG/ifc-lite/commit/958aef125743682da75c3da7b41991abd9d36d32), [`de7bd04`](https://github.com/LTplus-AG/ifc-lite/commit/de7bd04619a43a32900b188e0507b95e7542d8c8), [`09d67c7`](https://github.com/LTplus-AG/ifc-lite/commit/09d67c780bf68f58dec3f77920927857c752f8da), [`72bf949`](https://github.com/LTplus-AG/ifc-lite/commit/72bf949bd3a58dfb460c2c445e546d930a248e02), [`512406f`](https://github.com/LTplus-AG/ifc-lite/commit/512406f0d21c7e33b8c84a83865ffaff299e7cc1), [`81e5415`](https://github.com/LTplus-AG/ifc-lite/commit/81e541588ff5e5665b9091179a87bc4d03cd77f9), [`5d763d6`](https://github.com/LTplus-AG/ifc-lite/commit/5d763d6bde10c0232cbf28e7d8e4e956ebaf4ff1), [`0671811`](https://github.com/LTplus-AG/ifc-lite/commit/0671811856888b8b930d3068166cff286a21a8c2), [`f9f5fb7`](https://github.com/LTplus-AG/ifc-lite/commit/f9f5fb701ea0ace55a68c7d53085774052ee8995), [`a803c35`](https://github.com/LTplus-AG/ifc-lite/commit/a803c3599d777669341b69309e7dab20cdf16db0)]:
  - @ifc-lite/bcf@1.17.0
  - @ifc-lite/cache@3.0.3
  - @ifc-lite/renderer@1.43.0
  - @ifc-lite/collab@0.4.2
  - @ifc-lite/create@2.0.2
  - @ifc-lite/merge@0.4.1
  - @ifc-lite/drawing-2d@1.21.1
  - @ifc-lite/export@2.8.3
  - @ifc-lite/query@1.14.16
  - @ifc-lite/data@3.2.2
  - @ifc-lite/mcp@0.11.1
  - @ifc-lite/encoding@1.15.1
  - @ifc-lite/ids@1.15.42
  - @ifc-lite/ifcx@2.3.4
  - @ifc-lite/pointcloud@0.6.1
  - @ifc-lite/lists@1.22.4
  - @ifc-lite/server-client@1.22.0
  - @ifc-lite/parser@4.0.0
  - @ifc-lite/mutations@1.24.2
  - @ifc-lite/geometry@3.7.1
  - @ifc-lite/sandbox@2.1.0
  - @ifc-lite/clash@1.6.5
  - @ifc-lite/sdk@2.0.3

## 1.14.15

### Patch Changes

- Updated dependencies [[`58f0473`](https://github.com/LTplus-AG/ifc-lite/commit/58f0473b792e6bd29b42f16bac41fc398ecb600d), [`2c47277`](https://github.com/LTplus-AG/ifc-lite/commit/2c47277ee6dfbd9779eb4948d1f2e7b0ea61d00e), [`5371d7d`](https://github.com/LTplus-AG/ifc-lite/commit/5371d7def2671f6568c838879b8be058bb6247c9), [`bdeb80d`](https://github.com/LTplus-AG/ifc-lite/commit/bdeb80d79443d89027a4d96879116e99dcc989a4), [`b3742d9`](https://github.com/LTplus-AG/ifc-lite/commit/b3742d9d29c3adfcbf67f573c62194547d7d172d), [`803005f`](https://github.com/LTplus-AG/ifc-lite/commit/803005f1c8d976350111c2f52a6b41b584393ca6), [`9d9c804`](https://github.com/LTplus-AG/ifc-lite/commit/9d9c8049075c9d8692a483ef1fa75325e822c15a), [`a25dd32`](https://github.com/LTplus-AG/ifc-lite/commit/a25dd32a78626a0ed697a21ed2c4963641bb7b89), [`07c0b4c`](https://github.com/LTplus-AG/ifc-lite/commit/07c0b4cc5a0b5617ed6ad300639e5c52ce225d44), [`4c739be`](https://github.com/LTplus-AG/ifc-lite/commit/4c739be2aba74ad6868b6dca51dad441c6fa9903), [`d85ef9b`](https://github.com/LTplus-AG/ifc-lite/commit/d85ef9bb725843f682463496e7a8f2d2ab9b83f1), [`f493930`](https://github.com/LTplus-AG/ifc-lite/commit/f4939309aed136979bd5cc1f95a25c2a0ebe779f), [`befc108`](https://github.com/LTplus-AG/ifc-lite/commit/befc1083e377315231006352cb3fe95949e92b47), [`6722e08`](https://github.com/LTplus-AG/ifc-lite/commit/6722e08b76c4cd89d8e7e1bbd06c768a36ae93ac), [`6cbf69a`](https://github.com/LTplus-AG/ifc-lite/commit/6cbf69acb2163ab671c41df36878f4d4e490e244), [`f566a3a`](https://github.com/LTplus-AG/ifc-lite/commit/f566a3af5d92728d682a150282e37de3ece3a613), [`f566a3a`](https://github.com/LTplus-AG/ifc-lite/commit/f566a3af5d92728d682a150282e37de3ece3a613), [`0ceb99a`](https://github.com/LTplus-AG/ifc-lite/commit/0ceb99a36125a2dfc8775e762d9f4f9ddb69d733), [`996f50f`](https://github.com/LTplus-AG/ifc-lite/commit/996f50f6749182f3eb3465bd390ce75fe68e549c), [`5befec5`](https://github.com/LTplus-AG/ifc-lite/commit/5befec5b6b73d2293f058b3c010c8553429f6178), [`1dade49`](https://github.com/LTplus-AG/ifc-lite/commit/1dade49f39833b1d95eb8c5b78297f77bbddca15), [`9b53852`](https://github.com/LTplus-AG/ifc-lite/commit/9b53852464b1329733cd954754923b16abf9060d), [`b47928f`](https://github.com/LTplus-AG/ifc-lite/commit/b47928f9c684413a8762330320c6ebaf02ffbbeb), [`d1d82aa`](https://github.com/LTplus-AG/ifc-lite/commit/d1d82aae99386505917a68551f033299ed8b4924), [`1303515`](https://github.com/LTplus-AG/ifc-lite/commit/1303515b8aa87cd6e8215ecf88fdf5a406b545d8), [`e03d879`](https://github.com/LTplus-AG/ifc-lite/commit/e03d879a96ba9a5818a7264d713237833e201ba3), [`a2787fa`](https://github.com/LTplus-AG/ifc-lite/commit/a2787fab292e50d60ed0081fd3d458e7555c5cb2), [`a77fbd1`](https://github.com/LTplus-AG/ifc-lite/commit/a77fbd1f4c52a5d13bd51fe37a70d306315df7fa), [`ae2debf`](https://github.com/LTplus-AG/ifc-lite/commit/ae2debf665fdbe25afd9e16411bd2347dcd4f39d), [`3c2ffa6`](https://github.com/LTplus-AG/ifc-lite/commit/3c2ffa6a1bd0a04d3d73e2ea7c0fb1a2233599a9), [`d44b6c1`](https://github.com/LTplus-AG/ifc-lite/commit/d44b6c1710ee86596e96e0204785d2bf7c0940a9)]:
  - @ifc-lite/renderer@1.42.0
  - @ifc-lite/geometry@3.7.0
  - @ifc-lite/export@2.8.2
  - @ifc-lite/pointcloud@0.6.0
  - @ifc-lite/mcp@0.11.0
  - @ifc-lite/mutations@1.24.1
  - @ifc-lite/wasm@4.3.1
  - @ifc-lite/data@3.2.1
  - @ifc-lite/cache@3.0.2
  - @ifc-lite/create@2.0.1
  - @ifc-lite/server-client@1.21.1
  - @ifc-lite/extensions@0.4.1
  - @ifc-lite/sdk@2.0.2
  - @ifc-lite/drawing-2d@1.21.0
  - @ifc-lite/sandbox@2.0.1
  - @ifc-lite/spatial@1.14.13
  - @ifc-lite/parser@3.15.1
  - @ifc-lite/ifcx@2.3.3
  - @ifc-lite/ids@1.15.41
  - @ifc-lite/lists@1.22.3

## 1.14.14

### Patch Changes

- Updated dependencies [[`59792cc`](https://github.com/LTplus-AG/ifc-lite/commit/59792cc7d15bba68708a88475861f499f7b15647), [`40e9c59`](https://github.com/LTplus-AG/ifc-lite/commit/40e9c5931fab27b0de05655e08804562dd794389), [`af869bd`](https://github.com/LTplus-AG/ifc-lite/commit/af869bd6c8133d8d13c9d62edecf04c37baa0245), [`d42fbf1`](https://github.com/LTplus-AG/ifc-lite/commit/d42fbf1c7a4abed637b7e80e28cbed69088bc943), [`e651699`](https://github.com/LTplus-AG/ifc-lite/commit/e651699180b791b95cbd721ad66d5f38e03eca2b), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`63905dc`](https://github.com/LTplus-AG/ifc-lite/commit/63905dc3993ad227500a0f68c406276c909eb6f5), [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab), [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab), [`0adb741`](https://github.com/LTplus-AG/ifc-lite/commit/0adb7413b869c9d50bdcdae5c00a730d17c2823f), [`263c3ef`](https://github.com/LTplus-AG/ifc-lite/commit/263c3efba5baf503f192700ba7f70ce08a1dafc8), [`e4782e8`](https://github.com/LTplus-AG/ifc-lite/commit/e4782e8362c0899d0df1070d5eafb70ef18481b6), [`a2ca053`](https://github.com/LTplus-AG/ifc-lite/commit/a2ca0535c14cd1bf9d55713584766dff55430158), [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275), [`c868444`](https://github.com/LTplus-AG/ifc-lite/commit/c868444e94348a34cbea2b130968a6c7affc474e), [`084c32c`](https://github.com/LTplus-AG/ifc-lite/commit/084c32c26c82dedb32ef62d38fc60c4965c741e1), [`678e90d`](https://github.com/LTplus-AG/ifc-lite/commit/678e90d93e97d2b9ec3c8de9f2713e83361cab18), [`678e90d`](https://github.com/LTplus-AG/ifc-lite/commit/678e90d93e97d2b9ec3c8de9f2713e83361cab18), [`a5cc568`](https://github.com/LTplus-AG/ifc-lite/commit/a5cc568a642d7dd8d17f1ed7858844f9289bc841), [`a8e58a2`](https://github.com/LTplus-AG/ifc-lite/commit/a8e58a2b5e75db8388835c77b2688240667f68ab), [`a5cc568`](https://github.com/LTplus-AG/ifc-lite/commit/a5cc568a642d7dd8d17f1ed7858844f9289bc841), [`dc000cf`](https://github.com/LTplus-AG/ifc-lite/commit/dc000cff25a647d2a224f34a063f84b3d2d84ca8), [`e4d2db5`](https://github.com/LTplus-AG/ifc-lite/commit/e4d2db5f11798e3ec78f45249139d69aa1e65275), [`2716893`](https://github.com/LTplus-AG/ifc-lite/commit/2716893ac9d825fc529f3fd8164d9a6f766e87f8), [`620f4d2`](https://github.com/LTplus-AG/ifc-lite/commit/620f4d2100b397d33d2e61440950b7a31660dbb8), [`7261f1a`](https://github.com/LTplus-AG/ifc-lite/commit/7261f1a6a8595350d3ec400212e293a8924d57bf), [`8967a03`](https://github.com/LTplus-AG/ifc-lite/commit/8967a033704a7edbb03140291df7a8536d3dd892), [`8f139a8`](https://github.com/LTplus-AG/ifc-lite/commit/8f139a8ef44235b68c2f97c032419fa586111b62), [`ed63063`](https://github.com/LTplus-AG/ifc-lite/commit/ed63063c952bd1804ce83922da80635f03c77193)]:
  - @ifc-lite/wasm@4.3.0
  - @ifc-lite/diff@0.6.0
  - @ifc-lite/export@2.8.0
  - @ifc-lite/mcp@0.10.0
  - @ifc-lite/geometry@3.6.0
  - @ifc-lite/parser@3.13.0
  - @ifc-lite/data@3.2.0
  - @ifc-lite/mutations@1.23.0
  - @ifc-lite/sdk@2.0.0
  - @ifc-lite/create@2.0.0
  - @ifc-lite/sandbox@2.0.0
  - @ifc-lite/merge@0.4.0
  - @ifc-lite/ids@1.15.38
  - @ifc-lite/lists@1.22.2

## 1.14.13

### Patch Changes

- Updated dependencies [[`8793ffd`](https://github.com/LTplus-AG/ifc-lite/commit/8793ffd4948840fbd96bf745d8e9db71e139d350), [`15f5335`](https://github.com/LTplus-AG/ifc-lite/commit/15f53357f30a38d6aef7c9e4394c14400f5222e5), [`80051a5`](https://github.com/LTplus-AG/ifc-lite/commit/80051a51868b7343c4c3e08e335c0d5bdf900424), [`72b896b`](https://github.com/LTplus-AG/ifc-lite/commit/72b896b27eed3f394c76d602a2d1b2eb8db82e2f), [`4af7d75`](https://github.com/LTplus-AG/ifc-lite/commit/4af7d7590759bbcc7a39b0b48f06f980bb57414b), [`0571583`](https://github.com/LTplus-AG/ifc-lite/commit/05715834ce94a1f8e5dc20d6a60b7468190c2e88)]:
  - @ifc-lite/wasm@4.2.2
  - @ifc-lite/diff@0.5.0
  - @ifc-lite/mutations@1.22.0
  - @ifc-lite/export@2.7.1
  - @ifc-lite/lens@1.17.3
  - @ifc-lite/renderer@1.41.1
  - @ifc-lite/parser@3.12.0
  - @ifc-lite/ids@1.15.37
  - @ifc-lite/merge@0.3.2

## 1.14.12

### Patch Changes

- Updated dependencies [[`0cfb88b`](https://github.com/LTplus-AG/ifc-lite/commit/0cfb88b3ac3e5615c7e125c5076ea75cf2039a09), [`382fa7c`](https://github.com/LTplus-AG/ifc-lite/commit/382fa7cf97c04bad07963e25052cbaeb6c2ba7e3), [`6792dd1`](https://github.com/LTplus-AG/ifc-lite/commit/6792dd11ad7049acb7329221ea8809d6333aefb7), [`0f15d56`](https://github.com/LTplus-AG/ifc-lite/commit/0f15d5629c532a9ae6b8d79586e6b16613000498), [`35c157d`](https://github.com/LTplus-AG/ifc-lite/commit/35c157d9a0513f368e83c4884465b5ad162c6ba0), [`401ab18`](https://github.com/LTplus-AG/ifc-lite/commit/401ab1842662c4e8ca26eae01b879f0290962b6d), [`87f3507`](https://github.com/LTplus-AG/ifc-lite/commit/87f3507f6fb67a3fd834a190737ea33d7e9ad661), [`8492e51`](https://github.com/LTplus-AG/ifc-lite/commit/8492e516f23775930e55a192abe526ff507d79bc), [`6842c56`](https://github.com/LTplus-AG/ifc-lite/commit/6842c56c72065fd9f43ac282cacb766b7808c282), [`a58feb3`](https://github.com/LTplus-AG/ifc-lite/commit/a58feb3d193106e79598f764deb01e6559bf2e61), [`b23a173`](https://github.com/LTplus-AG/ifc-lite/commit/b23a173775785eea179d7c243948bb86401920f4), [`653a685`](https://github.com/LTplus-AG/ifc-lite/commit/653a685625bda0c983a3123dda73e0d009529f4b), [`33a83dc`](https://github.com/LTplus-AG/ifc-lite/commit/33a83dc61ce6ba1fc3a75869c96ed7afbeb1340f), [`6869d5c`](https://github.com/LTplus-AG/ifc-lite/commit/6869d5ced2d19ac4ab8b2591847f3ffd52236d14), [`319486c`](https://github.com/LTplus-AG/ifc-lite/commit/319486c1ca4fccf7ad3d5ea8187af5c361201131), [`19dc013`](https://github.com/LTplus-AG/ifc-lite/commit/19dc013d66bd96a8ad7b7a01f9c495c829d4ba8b), [`d7065f9`](https://github.com/LTplus-AG/ifc-lite/commit/d7065f9bd08cd12d8b17c9f11f0adcd38e0ee1f3), [`ae0498a`](https://github.com/LTplus-AG/ifc-lite/commit/ae0498a23d61dd63baede3df86cd2f9ec74b1203), [`8799484`](https://github.com/LTplus-AG/ifc-lite/commit/87994844a5edb66404fa12b0719c89f5ec026c4d), [`22bffac`](https://github.com/LTplus-AG/ifc-lite/commit/22bffac737efa9bdd6ca583518f637593cb4d4bc), [`2738f9b`](https://github.com/LTplus-AG/ifc-lite/commit/2738f9b51efd3795259bd4c8870cf13016a989ba), [`87f3507`](https://github.com/LTplus-AG/ifc-lite/commit/87f3507f6fb67a3fd834a190737ea33d7e9ad661), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`205a136`](https://github.com/LTplus-AG/ifc-lite/commit/205a136ee69e378ea01cd0d0a8a6dc81cf2fb08f), [`2738f9b`](https://github.com/LTplus-AG/ifc-lite/commit/2738f9b51efd3795259bd4c8870cf13016a989ba), [`b716fd7`](https://github.com/LTplus-AG/ifc-lite/commit/b716fd7b045c918dc1bd2ecc1da6fed21e59f110), [`428c5ae`](https://github.com/LTplus-AG/ifc-lite/commit/428c5ae54bac236a3950f451ee12a0dc23226336), [`3dc3eb5`](https://github.com/LTplus-AG/ifc-lite/commit/3dc3eb56bd372ddd0e317347db1cad888dffd609), [`f8a3f39`](https://github.com/LTplus-AG/ifc-lite/commit/f8a3f3970844edf266ae6887884ed3be4293ff8c)]:
  - @ifc-lite/clash@1.6.4
  - @ifc-lite/wasm@4.2.0
  - @ifc-lite/create@1.17.0
  - @ifc-lite/encoding@1.15.0
  - @ifc-lite/data@3.0.0
  - @ifc-lite/cache@3.0.0
  - @ifc-lite/drawing-2d@1.20.0
  - @ifc-lite/lists@1.22.0
  - @ifc-lite/parser@3.11.0
  - @ifc-lite/renderer@1.40.0
  - @ifc-lite/pointcloud@0.5.0
  - @ifc-lite/export@2.7.0
  - @ifc-lite/mutations@1.21.1
  - @ifc-lite/sandbox@1.16.4
  - @ifc-lite/server-client@1.21.0
  - @ifc-lite/ifcx@2.3.2
  - @ifc-lite/geometry@3.5.0
  - @ifc-lite/collab@0.4.1
  - @ifc-lite/ids@1.15.35
  - @ifc-lite/mcp@0.9.2
  - @ifc-lite/query@1.14.14
  - @ifc-lite/sdk@1.21.3

## 1.14.11

### Patch Changes

- Updated dependencies [[`37224e8`](https://github.com/LTplus-AG/ifc-lite/commit/37224e8cd852d246cf463622cd612a38e0cf6e27), [`2a7c7ff`](https://github.com/LTplus-AG/ifc-lite/commit/2a7c7ffe0ac27a8cc315e5d4a633c56469646cf0), [`631c3a0`](https://github.com/LTplus-AG/ifc-lite/commit/631c3a0813e722fa65ff052108c2cea3ac905801), [`90522d2`](https://github.com/LTplus-AG/ifc-lite/commit/90522d218d5a9c4df0760349b5bfc60916a23f8f), [`613a1bf`](https://github.com/LTplus-AG/ifc-lite/commit/613a1bf6e8f6b3678ce6bd214e746e82dd11f73d), [`502c61b`](https://github.com/LTplus-AG/ifc-lite/commit/502c61bc7c0ae1ac313ed93ab335fdd942471c72), [`05c8bdf`](https://github.com/LTplus-AG/ifc-lite/commit/05c8bdf348c5afae8978293cd324d45104e24940), [`7dcf3e1`](https://github.com/LTplus-AG/ifc-lite/commit/7dcf3e1e33101c694f0acc74aa77cf07770c63c5), [`7194c95`](https://github.com/LTplus-AG/ifc-lite/commit/7194c95002f2c84cd3c9444d710a50190a976a90), [`502bdbf`](https://github.com/LTplus-AG/ifc-lite/commit/502bdbf5c4c4c86999f4e662b71ee5b0b16307ae), [`6102a22`](https://github.com/LTplus-AG/ifc-lite/commit/6102a222a6a71afcdab89855f1dcfa9437d3994f)]:
  - @ifc-lite/export@2.6.0
  - @ifc-lite/geometry@3.3.0
  - @ifc-lite/wasm@4.1.0
  - @ifc-lite/data@2.7.0
  - @ifc-lite/mutations@1.21.0
  - @ifc-lite/drawing-2d@1.19.0
  - @ifc-lite/ids@1.15.33
  - @ifc-lite/parser@3.10.0
  - @ifc-lite/renderer@1.39.0
  - @ifc-lite/pointcloud@0.4.0
  - @ifc-lite/server-client@1.20.0
  - @ifc-lite/lists@1.20.1
  - @ifc-lite/ifcx@2.3.1

## 1.14.10

### Patch Changes

- Updated dependencies [[`c1695d7`](https://github.com/LTplus-AG/ifc-lite/commit/c1695d777263483110460df767ec86ca691048ab), [`5e90494`](https://github.com/LTplus-AG/ifc-lite/commit/5e904942e3fd167d0d0e1a9c37b391d638eb6932), [`cd6c9bd`](https://github.com/LTplus-AG/ifc-lite/commit/cd6c9bda1066b7c7cda19e164d787d15b57e3483), [`b54f704`](https://github.com/LTplus-AG/ifc-lite/commit/b54f70478a7b92055750f11267ffe7fa47ed7da1)]:
  - @ifc-lite/collab@0.4.0
  - @ifc-lite/merge@0.3.0
  - @ifc-lite/mutations@1.20.0
  - @ifc-lite/mcp@0.9.0

## 1.14.9

### Patch Changes

- Updated dependencies [[`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`9689ea5`](https://github.com/LTplus-AG/ifc-lite/commit/9689ea5276cc107895be56aa9267a4b7b778de2d), [`62b68c0`](https://github.com/LTplus-AG/ifc-lite/commit/62b68c06347aab661c3d9417bcf016e565e2c4b1), [`8f3fafd`](https://github.com/LTplus-AG/ifc-lite/commit/8f3fafd7cc777e60cdc006956f8336680723c440), [`a2c31a1`](https://github.com/LTplus-AG/ifc-lite/commit/a2c31a185e868d15183df8360badb001789bd978), [`6ed4de6`](https://github.com/LTplus-AG/ifc-lite/commit/6ed4de6a46100e097b41137a65e91b581df34486), [`a1bbd6c`](https://github.com/LTplus-AG/ifc-lite/commit/a1bbd6c209ded2da1405a8d1c816a193601ae625)]:
  - @ifc-lite/ifcx@2.3.0
  - @ifc-lite/mutations@1.19.0
  - @ifc-lite/collab@0.3.0
  - @ifc-lite/renderer@1.37.0
  - @ifc-lite/geometry@3.2.0
  - @ifc-lite/wasm@4.0.0
  - @ifc-lite/parser@3.8.5
  - @ifc-lite/ids@1.15.30

## 1.14.8

### Patch Changes

- Updated dependencies [[`8e43ecf`](https://github.com/LTplus-AG/ifc-lite/commit/8e43ecf540b88b942a4ec2127dd9bcf24ec244fa), [`796f50a`](https://github.com/LTplus-AG/ifc-lite/commit/796f50a3b0072dd2c07b60ef84e3f1d2996444e2), [`d1e16f9`](https://github.com/LTplus-AG/ifc-lite/commit/d1e16f944ea9f3a35a7153959f13db168a35c229), [`7d5a031`](https://github.com/LTplus-AG/ifc-lite/commit/7d5a03191a768f68c5ddad878698d1aacb9940ef), [`a46dcdf`](https://github.com/LTplus-AG/ifc-lite/commit/a46dcdf68d05e8cdec4199167647f2dfa3c62cb6), [`6d2cb21`](https://github.com/LTplus-AG/ifc-lite/commit/6d2cb21a170413c6c98aadf10d254667b2ed2b53), [`66f31ac`](https://github.com/LTplus-AG/ifc-lite/commit/66f31acb761209f7cf78e83ef01c02a1ec3dc13a), [`204cab4`](https://github.com/LTplus-AG/ifc-lite/commit/204cab48f8e3b6326a8005628ed5b7174d9d694c), [`a48abac`](https://github.com/LTplus-AG/ifc-lite/commit/a48abacfacdf226702f2454859afe9abe018e029), [`3d25765`](https://github.com/LTplus-AG/ifc-lite/commit/3d25765edc2cee40268a6d5a27d4055f88f76489), [`6a515ba`](https://github.com/LTplus-AG/ifc-lite/commit/6a515ba31bbe31bb6f018f7476cc9616e4691448), [`b66ff1d`](https://github.com/LTplus-AG/ifc-lite/commit/b66ff1dd915a0ff4f60198a511adb7ed7f714079)]:
  - @ifc-lite/wasm@3.0.0
  - @ifc-lite/geometry@3.0.0
  - @ifc-lite/renderer@1.34.0
  - @ifc-lite/ifcx@2.1.6
  - @ifc-lite/data@2.3.0
  - @ifc-lite/query@1.14.11
  - @ifc-lite/cache@2.0.10
  - @ifc-lite/server-client@1.18.1
  - @ifc-lite/encoding@1.14.8
  - @ifc-lite/export@2.4.0
  - @ifc-lite/parser@3.5.2
  - @ifc-lite/drawing-2d@1.18.5
  - @ifc-lite/spatial@1.14.10
  - @ifc-lite/ids@1.15.22
  - @ifc-lite/lists@1.16.1

## 1.14.7

### Patch Changes

- Updated dependencies [[`fec82b9`](https://github.com/LTplus-AG/ifc-lite/commit/fec82b9f3eea3655f92413fce82387ddce2f9722), [`0a0a922`](https://github.com/LTplus-AG/ifc-lite/commit/0a0a922adba1dabc56e97cc5ce0c553ab7356b3e)]:
  - @ifc-lite/geometry@2.9.0
  - @ifc-lite/wasm@2.11.0
  - @ifc-lite/export@2.0.0
  - @ifc-lite/sdk@1.20.1

## 1.14.6

### Patch Changes

- Updated dependencies [[`ea7c132`](https://github.com/LTplus-AG/ifc-lite/commit/ea7c1324e77b5fde4b7d0775a013f2fdf90b26d2), [`1effb90`](https://github.com/LTplus-AG/ifc-lite/commit/1effb900edd0a70db75f90839a4cc9f8fecb8d5e), [`1effb90`](https://github.com/LTplus-AG/ifc-lite/commit/1effb900edd0a70db75f90839a4cc9f8fecb8d5e), [`b6f352f`](https://github.com/LTplus-AG/ifc-lite/commit/b6f352f75e1431cf926eca0dcb3344aead140c2f), [`35413b9`](https://github.com/LTplus-AG/ifc-lite/commit/35413b9efd0178cff6022f2b1092ac532868d6cd)]:
  - @ifc-lite/cache@2.0.0
  - @ifc-lite/drawing-2d@1.17.0
  - @ifc-lite/wasm@2.4.0
  - @ifc-lite/geometry@2.4.0

## 1.14.5

### Patch Changes

- Updated dependencies [[`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85), [`e73ac09`](https://github.com/LTplus-AG/ifc-lite/commit/e73ac0931b85cd299ae9b723073e956b6b124c85)]:
  - @ifc-lite/parser@3.0.0
  - @ifc-lite/export@1.19.3
  - @ifc-lite/cache@1.14.8
  - @ifc-lite/renderer@1.23.1
  - @ifc-lite/wasm@2.0.0
  - @ifc-lite/geometry@2.0.0
  - @ifc-lite/data@2.0.0
  - @ifc-lite/create@1.15.1
  - @ifc-lite/ids@1.15.4
  - @ifc-lite/query@1.14.8
  - @ifc-lite/sdk@1.16.1
  - @ifc-lite/drawing-2d@1.16.1
  - @ifc-lite/spatial@1.14.6
  - @ifc-lite/ifcx@2.1.2
  - @ifc-lite/lists@1.14.13
  - @ifc-lite/mutations@1.15.1

## 1.14.4

### Patch Changes

- Updated dependencies [[`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5), [`ba9040c`](https://github.com/louistrue/ifc-lite/commit/ba9040c6ff3204f3a936dd2f481c4cd8a4e6f5b5)]:
  - @ifc-lite/ifcx@2.0.0
  - @ifc-lite/parser@2.0.0
  - @ifc-lite/export@1.14.4
  - @ifc-lite/query@1.14.4
  - @ifc-lite/sdk@1.14.4

## 1.14.3

### Patch Changes

- Updated dependencies [[`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`07851b2`](https://github.com/louistrue/ifc-lite/commit/07851b2161b4cfcaa2dfc1b0f31a6fcc2db99e45), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0), [`041ddb4`](https://github.com/louistrue/ifc-lite/commit/041ddb4a40c7e23b08fb7b7ce42690a9cc9708a0)]:
  - @ifc-lite/sdk@1.14.3
  - @ifc-lite/mutations@1.14.3
  - @ifc-lite/wasm@1.14.3
  - @ifc-lite/sandbox@1.14.3
  - @ifc-lite/geometry@1.14.3
  - @ifc-lite/export@1.14.3
  - @ifc-lite/bcf@1.14.3
  - @ifc-lite/cache@1.14.3
  - @ifc-lite/data@1.14.3
  - @ifc-lite/drawing-2d@1.14.3
  - @ifc-lite/embed-protocol@1.14.3
  - @ifc-lite/ids@1.14.3
  - @ifc-lite/ifcx@1.14.3
  - @ifc-lite/parser@1.14.3
  - @ifc-lite/query@1.14.3
  - @ifc-lite/renderer@1.14.3
  - @ifc-lite/server-client@1.14.3
  - @ifc-lite/spatial@1.14.3

## 1.14.2

### Patch Changes

- Updated dependencies [[`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3), [`740f7a7`](https://github.com/louistrue/ifc-lite/commit/740f7a7228413657d13014565d9e457f0e00e8a3)]:
  - @ifc-lite/export@1.14.2
  - @ifc-lite/parser@1.14.2
  - @ifc-lite/bcf@1.14.2
  - @ifc-lite/cache@1.14.2
  - @ifc-lite/data@1.14.2
  - @ifc-lite/drawing-2d@1.14.2
  - @ifc-lite/embed-protocol@1.14.2
  - @ifc-lite/geometry@1.14.2
  - @ifc-lite/ids@1.14.2
  - @ifc-lite/ifcx@1.14.2
  - @ifc-lite/mutations@1.14.2
  - @ifc-lite/query@1.14.2
  - @ifc-lite/renderer@1.14.2
  - @ifc-lite/server-client@1.14.2
  - @ifc-lite/spatial@1.14.2
  - @ifc-lite/wasm@1.14.2

## 1.14.1

### Patch Changes

- Updated dependencies [[`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`071d251`](https://github.com/louistrue/ifc-lite/commit/071d251708388771afd288bc2ef01b4d1a074607), [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0), [`efb5c82`](https://github.com/louistrue/ifc-lite/commit/efb5c82e5ce0567443f348d382bce922e4b270f0)]:
  - @ifc-lite/renderer@1.14.1
  - @ifc-lite/spatial@1.14.1
  - @ifc-lite/geometry@1.14.1
  - @ifc-lite/wasm@1.14.1
  - @ifc-lite/parser@1.14.1
  - @ifc-lite/bcf@1.14.1
  - @ifc-lite/cache@1.14.1
  - @ifc-lite/data@1.14.1
  - @ifc-lite/drawing-2d@1.14.1
  - @ifc-lite/embed-protocol@1.14.1
  - @ifc-lite/export@1.14.1
  - @ifc-lite/ids@1.14.1
  - @ifc-lite/ifcx@1.14.1
  - @ifc-lite/mutations@1.14.1
  - @ifc-lite/query@1.14.1
  - @ifc-lite/server-client@1.14.1

## 1.14.0

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/bcf@1.14.0
  - @ifc-lite/cache@1.14.0
  - @ifc-lite/data@1.14.0
  - @ifc-lite/drawing-2d@1.14.0
  - @ifc-lite/embed-protocol@1.14.0
  - @ifc-lite/export@1.14.0
  - @ifc-lite/geometry@1.14.0
  - @ifc-lite/ids@1.14.0
  - @ifc-lite/ifcx@1.14.0
  - @ifc-lite/mutations@1.14.0
  - @ifc-lite/parser@1.14.0
  - @ifc-lite/query@1.14.0
  - @ifc-lite/renderer@1.14.0
  - @ifc-lite/server-client@1.14.0
  - @ifc-lite/spatial@1.14.0
  - @ifc-lite/wasm@1.14.0

## 1.13.0

### Patch Changes

- Updated dependencies [[`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c), [`3bc1cda`](https://github.com/louistrue/ifc-lite/commit/3bc1cdabcff1d9992ec6799ddbd83a169152fa3c)]:
  - @ifc-lite/renderer@1.13.0
  - @ifc-lite/bcf@1.13.0
  - @ifc-lite/cache@1.13.0
  - @ifc-lite/data@1.13.0
  - @ifc-lite/drawing-2d@1.13.0
  - @ifc-lite/embed-protocol@1.13.0
  - @ifc-lite/export@1.13.0
  - @ifc-lite/geometry@1.13.0
  - @ifc-lite/ids@1.13.0
  - @ifc-lite/ifcx@1.13.0
  - @ifc-lite/mutations@1.13.0
  - @ifc-lite/parser@1.13.0
  - @ifc-lite/query@1.13.0
  - @ifc-lite/server-client@1.13.0
  - @ifc-lite/spatial@1.13.0
  - @ifc-lite/wasm@1.13.0

## 1.12.0

### Patch Changes

- Updated dependencies [[`2562382`](https://github.com/louistrue/ifc-lite/commit/25623821fa6d7e94b094772563811fb01ce066c7)]:
  - @ifc-lite/export@1.12.0
  - @ifc-lite/bcf@1.12.0
  - @ifc-lite/cache@1.12.0
  - @ifc-lite/data@1.12.0
  - @ifc-lite/drawing-2d@1.12.0
  - @ifc-lite/embed-protocol@1.12.0
  - @ifc-lite/geometry@1.12.0
  - @ifc-lite/ids@1.12.0
  - @ifc-lite/ifcx@1.12.0
  - @ifc-lite/mutations@1.12.0
  - @ifc-lite/parser@1.12.0
  - @ifc-lite/query@1.12.0
  - @ifc-lite/renderer@1.12.0
  - @ifc-lite/server-client@1.12.0
  - @ifc-lite/spatial@1.12.0
  - @ifc-lite/wasm@1.12.0

## 1.11.3

### Patch Changes

- Updated dependencies []:
  - @ifc-lite/bcf@1.11.3
  - @ifc-lite/cache@1.11.3
  - @ifc-lite/data@1.11.3
  - @ifc-lite/drawing-2d@1.11.3
  - @ifc-lite/embed-protocol@1.11.3
  - @ifc-lite/export@1.11.3
  - @ifc-lite/geometry@1.11.3
  - @ifc-lite/ids@1.11.3
  - @ifc-lite/ifcx@1.11.3
  - @ifc-lite/mutations@1.11.3
  - @ifc-lite/parser@1.11.3
  - @ifc-lite/query@1.11.3
  - @ifc-lite/renderer@1.11.3
  - @ifc-lite/server-client@1.11.3
  - @ifc-lite/spatial@1.11.3
  - @ifc-lite/wasm@1.11.3

## 1.11.1

### Patch Changes

- Updated dependencies [[`02876ac`](https://github.com/louistrue/ifc-lite/commit/02876ac97748ca9aaabfc3e5882ef9d2a37ca437)]:
  - @ifc-lite/geometry@1.11.1
  - @ifc-lite/bcf@1.11.1
  - @ifc-lite/cache@1.11.1
  - @ifc-lite/data@1.11.1
  - @ifc-lite/drawing-2d@1.11.1
  - @ifc-lite/embed-protocol@1.11.1
  - @ifc-lite/export@1.11.1
  - @ifc-lite/ids@1.11.1
  - @ifc-lite/ifcx@1.11.1
  - @ifc-lite/mutations@1.11.1
  - @ifc-lite/parser@1.11.1
  - @ifc-lite/query@1.11.1
  - @ifc-lite/renderer@1.11.1
  - @ifc-lite/server-client@1.11.1
  - @ifc-lite/spatial@1.11.1
  - @ifc-lite/wasm@1.11.1

## 1.11.0

### Patch Changes

- Updated dependencies [[`5a18e6c`](https://github.com/louistrue/ifc-lite/commit/5a18e6cccbc94d244c78a571b9f2c4863326190d), [`ca7fd20`](https://github.com/louistrue/ifc-lite/commit/ca7fd2015923e5a1a330ccbc4e95d259f9ce9c6f)]:
  - @ifc-lite/renderer@1.11.0
  - @ifc-lite/wasm@1.11.0
  - @ifc-lite/bcf@1.11.0
  - @ifc-lite/cache@1.11.0
  - @ifc-lite/data@1.11.0
  - @ifc-lite/drawing-2d@1.11.0
  - @ifc-lite/embed-protocol@1.11.0
  - @ifc-lite/export@1.11.0
  - @ifc-lite/geometry@1.11.0
  - @ifc-lite/ids@1.11.0
  - @ifc-lite/ifcx@1.11.0
  - @ifc-lite/mutations@1.11.0
  - @ifc-lite/parser@1.11.0
  - @ifc-lite/query@1.11.0
  - @ifc-lite/server-client@1.11.0
  - @ifc-lite/spatial@1.11.0
