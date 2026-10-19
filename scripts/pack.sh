#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p dist
gnome-extensions pack --force --out-dir=dist \
    --extra-source=windowManager.js --extra-source=layout.js --extra-source=groups.js \
    --extra-source=overviewDrop.js --extra-source=tabNameDialog.js \
    --extra-source=overviewGroups.js \
    --extra-source=README.md --extra-source=docs .
