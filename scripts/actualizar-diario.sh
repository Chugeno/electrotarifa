#!/usr/bin/env bash
# Actualización diaria: scrapers (paternal.db local) → auto_link → sync a Turso → R2. Lo ejecuta el timer systemd electrotarifa-update.
set -euo pipefail
cd "$(dirname "$0")/.."
echo "=== $(date '+%F %T') Inicio actualización ==="

# Esperar resolución DNS tras reinicios recientes
for i in $(seq 1 12); do
  if getent hosts paternalsrl.com.ar >/dev/null 2>&1; then
    break
  fi
  echo "⏳ Esperando DNS/red (intento $i/12)..."
  sleep 5
done

python3 scraper.py --provider all
python3 auto_link.py
npx tsx scripts/sync-to-turso.ts
npx tsx scripts/publish-catalog-r2.ts
echo "=== $(date '+%F %T') Fin ==="
