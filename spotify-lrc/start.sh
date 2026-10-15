#!/bin/sh
# Double-click (ya: sh start.sh) se server + browser khol do
cd "$(dirname "$0")" || exit 1
echo ""
echo " Spotify -> Synced Lyrics start ho raha hai..."
echo " Band karne ke liye Ctrl+C dabao."
echo ""
(sleep 2; xdg-open http://localhost:3000 2>/dev/null || open http://localhost:3000 2>/dev/null) &
node server.js
