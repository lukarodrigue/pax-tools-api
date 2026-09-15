#!/usr/bin/env bash
# Backup diário. Coloque no cron do host:
#   0 2 * * * /caminho/pax-tools/scripts/backup.sh >> /var/log/pax-tools-backup.log 2>&1
set -euo pipefail

PASTA="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PASTA"
set -a; source .env; set +a

mkdir -p backups
ARQUIVO="backups/paxtools-$(date +%Y%m%d-%H%M).sql.gz"

docker compose exec -T banco pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" | gzip > "$ARQUIVO"

# mantém 30 dias
find backups -name 'paxtools-*.sql.gz' -mtime +30 -delete

echo "$(date '+%F %T') backup gerado: $ARQUIVO ($(du -h "$ARQUIVO" | cut -f1))"
echo "ATENCAO: copie a pasta backups/ para fora deste servidor. Backup no mesmo disco nao e backup."
