#!/usr/bin/env bash
# package_v391.sh — build the v3.9.1 release zip with literal MUST-HAVE/MUST-NOT
# assertions (same discipline as package_v390.sh; the zip is the LAST gate).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OUT=/home/z/my-project/download/red-justice-v3.9.1-docx-table-fidelity.zip
STAGE=$(mktemp -d)
PKG="$STAGE/red-justice-v3.9.1"
mkdir -p "$PKG"

# ── tree: source, config, prisma, public, scripts (release tooling), .env, docs ──
rsync -a --delete \
  --exclude 'node_modules' --exclude '.next' --exclude 'dev.log' \
  --exclude 'prisma/db/*.db*' --exclude 'download' --exclude 'worklog.md' \
  --exclude 'scripts/_docx_scan_helper.mjs' \
  src package.json package-lock.json* bun.lock tsconfig.json next.config.ts \
  tailwind.config.ts postcss.config.mjs components.json eslint.config.mjs \
  prisma public README.md Dockerfile docker-compose.yml Caddyfile \
  copy-static.js setup.bat start-ollama.bat start-ollama.sh start-ollama.sh dev-watch.sh \
  .env "$PKG/" 2>/dev/null || true
[ -d "$PKG/src" ] || { echo "FATAL: src missing"; exit 1; }
# scripts/ (release tooling incl. regression battery) if present
[ -d scripts ] && rsync -a scripts/ "$PKG/scripts/" || true

# ── assertions ──
fail=0
must_have() { grep -rqF "$2" "$PKG/$1" && echo "  ok  $1 contains: $2" || { echo "  MISSING $1 :: $2"; fail=1; } }
must_not()  { ! grep -rqF "$2" "$PKG/$1" && echo "  ok  $1 free of: $2" || { echo "  FORBIDDEN $1 :: $2"; fail=1; } }

echo "== v3.9.1 literal assertions =="
must_have src/lib/extractors/fileParser.ts      'v3.9.1 TABLE-AWARE FLATTENING'
must_have src/lib/extractors/fileParser.ts      'TOKEN_RE'
must_have src/lib/extractors/fileParser.ts      "'</w:tr>'"
must_have src/lib/extractors/relTableExtract.ts 'splitLeadingRef'
must_have src/lib/extractors/relTableExtract.ts 'E0001 Arjun Sharma'
must_have src/lib/extractors/registryExtract.ts 'noiseVocabulary'
must_have src/lib/investigation/aiScan.ts       'filterRegistryNoiseAi'
must_have src/lib/investigation/aiScan.ts       'buildAiNoiseTokens'
must_have src/lib/investigation/aiScan.ts       'aiNoiseTokens'
must_have src/lib/investigation/aiScan.ts       'ATTR_CELL_RE'
must_have src/lib/investigation/aiScan.ts       'status=watchlist'
must_have src/lib/investigation/aiScanPrompts.ts "'event', 'other'"
must_have src/lib/investigation/aiScanPrompts.ts 'event: '
must_have src/lib/localAi.ts                    'LOCAL_AI_FAST_MODEL'
must_have src/app/api/cases                     'upload'
must_have package.json                          '"version": "3.9.1"'
must_have README.md                             'v3.9.1'
# the debris from the interrupted session must NOT ship (as FILES — the
# English word 'adversarial' legitimately lives in code comments)
DEBRIS_OK=1
for f in pipelineVersion.ts reviewQueue.ts gazetteer.ts ontology.ts adversarial.ts corefRules.ts chunkCoverage.ts; do
  found=$(find "$PKG/src" -name "$f" 2>/dev/null | head -1)
  if [ -n "$found" ]; then echo "  FORBIDDEN FILE: $f"; DEBRIS_OK=0; else echo "  ok  no $f"; fi
done
[ "$DEBRIS_OK" = 1 ] || fail=1

[ "$fail" = 0 ] || { echo "ASSERTIONS FAILED — no zip"; rm -rf "$STAGE"; exit 1; }

# ── zip ──
cd "$STAGE"
zip -rq "$OUT" red-justice-v3.9.1 -x '*.DS_Store'
cd /
rm -rf "$STAGE"
FILES=$(unzip -l "$OUT" | tail -1 | awk '{print $2}')
SIZE=$(du -h "$OUT" | cut -f1)
echo "PACKAGED: $OUT ($SIZE, $FILES files)"

# keep only the newest release in download/
ls /home/z/my-project/download/red-justice-v3.9.0-*.zip 2>/dev/null | while read -r old; do rm -f "$old"; echo "removed $(basename "$old")"; done
