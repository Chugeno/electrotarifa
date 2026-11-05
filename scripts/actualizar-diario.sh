#!/usr/bin/env bash
# Actualización diaria: scrapers (paternal.db local) → sync a Turso. Lo ejecuta el timer systemd electrotarifa-update.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "=== $(date '+%F %T') Inicio actualización ==="
python3 scraper.py --provider all
npx tsx scripts/sync-to-turso.ts
echo "=== $(date '+%F %T') Fin ==="
