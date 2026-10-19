#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# GNOME 46's typelib directory on Ubuntu 24.04 (no compositor is started).
export GI_TYPELIB_PATH="/usr/lib/x86_64-linux-gnu/mutter-14${GI_TYPELIB_PATH:+:$GI_TYPELIB_PATH}"
for source in extension.js windowManager.js layout.js groups.js overviewDrop.js tabNameDialog.js overviewGroups.js tests/run.js; do
    node --input-type=module --check < "$source"
done
python3 -m json.tool metadata.json > /dev/null
gjs -m tests/run.js
node --experimental-vm-modules tests/menu.mjs
node --experimental-vm-modules tests/groups.mjs
node --experimental-vm-modules tests/overview.mjs
node --experimental-vm-modules tests/overview-groups.mjs
git diff --check
