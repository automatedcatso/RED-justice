#!/bin/bash
# RED Justice dev server starter — uses the subshell fork trick to ensure
# the process is reparented to PID 1 (tini) and survives bash session exits.
#
# Usage: bash dev-watch.sh
#
# The server is started with setsid inside a subshell: ( setsid cmd & )
# This orphans the child immediately, causing it to be reparented to init.
cd /home/z/my-project

# Kill any existing next dev server
pkill -9 -f "next dev" 2>/dev/null
sleep 2

# Start using subshell fork trick — the key to cross-session survival
( setsid ./node_modules/.bin/next dev -p 3000 > /tmp/dev.log 2>&1 < /dev/null & )

# Wait for server to be ready
for i in $(seq 1 20); do
  sleep 1
  if curl -s http://localhost:3000/api/system/status --max-time 5 > /dev/null 2>&1; then
    echo "RED Justice dev server ready on port 3000 (PID reparented to init)"
    break
  fi
done

# Verify
curl -s http://localhost:3000/api/system/status --max-time 15
echo
