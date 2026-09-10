#!/usr/bin/env bash
# Double-clickable macOS launcher for install.sh.
# Finder runs this in a Terminal window; cd to its own folder, then install,
# and keep the window open so the summary stays visible.
cd "$(dirname "$0")" || exit 1
bash ./install.sh
status=$?
echo ""
echo "Press Return to close this window."
read -r _
exit $status
