#!/usr/bin/env bash
# SPDX-License-Identifier: MPL-2.0

# Valgrind comes from Ubuntu. Keep unrelated runner repositories out of both apt commands.
ubuntu_sources=(-o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources -o Dir::Etc::sourceparts=-)
for attempt in 1 2 3; do
  sudo apt-get "${ubuntu_sources[@]}" update &&
    sudo apt-get "${ubuntu_sources[@]}" install -y --no-install-recommends valgrind && exit 0
  sleep $((attempt * 15))
done
exit 1
