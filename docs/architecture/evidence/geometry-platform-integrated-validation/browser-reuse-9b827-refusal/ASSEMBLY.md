<!-- SPDX-License-Identifier: MPL-2.0 -->
# Reused adapter staging refused

Source9b827 terminal1, unchangedsource: frozen dependency install and all182fixture checks pass. Adapter source comparison and artifact hashes pass. The canonical staging command correctly refuses the prior build because its CMake source checkout differs from this checkout. No staged browser, Rust or Playwright tests ran. The guard remains unchanged; the next command must use a normal qualification build bound to its own checkout. This is a resolved setup diagnosis, not an adapter or browser numerical result.
