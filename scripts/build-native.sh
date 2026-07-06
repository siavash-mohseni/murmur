#!/usr/bin/env bash
# build-native.sh: compile the macOS native alert helper.
#
# The OS guard and the failure path are deliberately split. On Darwin we run
# swiftc directly so a genuine compile error propagates a non-zero exit and
# fails the build, instead of being swallowed by a "skip" fallback. On any
# other OS we skip cleanly with a zero exit.

set -euo pipefail

mkdir -p dist/native

if [ "$(uname)" = "Darwin" ]; then
  swiftc -O -swift-version 5 native-alert/MurmurAlert.swift -o dist/native/murmur-alert
else
  echo "skip native build (non-darwin)"
fi
