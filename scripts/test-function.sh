#!/usr/bin/env bash
# ======================================================
# TESTE LOCAL DA EDGE FUNCTION (sem Docker)
# ======================================================
#
# Sobe a function da Supabase com o Deno usando os secrets de
# supabase/.env.production e exercita as rotas principais.
#
#   bash scripts/test-function.sh
#
# ======================================================

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FUNCTION_DIR="$PROJECT_ROOT/supabase/functions/app"
ENV_FILE="$PROJECT_ROOT/supabase/.env.production"
PORT=8123
BASE="http://127.0.0.1:$PORT"

if [ ! -f "$ENV_FILE" ]; then
  echo "Arquivo de secrets não encontrado: $ENV_FILE"
  exit 1
fi

# Carrega os secrets.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

export SUPABASE_URL="${SUPABASE_URL:-https://xoacnxclwytocrubapap.supabase.co}"
export SUPABASE_PUBLISHABLE_KEY="${SUPABASE_PUBLISHABLE_KEY:-sb_publishable_owIbyeQ3GTvvv5XU5dY7BQ_OyOV8WWv}"
export PORT="$PORT"

echo "Subindo a function em $BASE ..."

# Garante que a porta está livre (execuções anteriores podem
# ter deixado o processo do Deno vivo).
for pid in $(ps -eo pid,args | grep "[d]eno run" | grep "index.ts" | awk '{print $1}'); do
  kill -9 "$pid" 2>/dev/null
done
sleep 1

(cd "$FUNCTION_DIR" && exec deno run \
  --node-modules-dir=auto \
  --allow-net \
  --allow-env \
  --allow-read \
  --allow-sys \
  index.ts > "$PROJECT_ROOT/.function-test.log" 2>&1) &
FUNCTION_PID=$!

cleanup() {
  kill "$FUNCTION_PID" 2>/dev/null
  wait "$FUNCTION_PID" 2>/dev/null
}

trap cleanup EXIT

# Aguarda a function responder.
for _ in $(seq 1 40); do
  sleep 0.5
  if curl -s -o /dev/null "$BASE/api/health"; then
    break
  fi
done

if ! curl -s -o /dev/null "$BASE/api/health"; then
  echo "A function não subiu. Log:"
  cat "$PROJECT_ROOT/.function-test.log"
  exit 1
fi

echo
echo "== health =="
curl -s "$BASE/api/health"; echo

echo
echo "== download/project (302 + contador) =="
curl -s -o /dev/null -w "status=%{http_code} destino=%{redirect_url}\n" \
  "$BASE/download/project"

echo
echo "== download/installer linux =="
curl -s -o /dev/null -w "status=%{http_code} destino=%{redirect_url}\n" \
  "$BASE/download/installer?platform=linux"

echo
echo "== download/source sem sessão (deve redirecionar) =="
curl -s -o /dev/null -w "status=%{http_code} destino=%{redirect_url}\n" \
  "$BASE/download/source"

echo
echo "== session sem cookie (401) =="
curl -s -o /dev/null -w "status=%{http_code}\n" "$BASE/api/session"

echo
echo "== admin/login com senha errada =="
curl -s -o /dev/null -w "status=%{http_code}\n" \
  -X POST "$BASE/api/admin/login" \
  -H 'Content-Type: application/json' \
  -d '{"password":"errada"}'

echo
echo "== admin/login + admin/users =="
ADMIN_TOKEN=$(curl -s \
  -X POST "$BASE/api/admin/login" \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$ADMIN_PASSWORD\"}" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

if [ -n "$ADMIN_TOKEN" ]; then
  echo "token recebido: ${#ADMIN_TOKEN} caracteres"
  curl -s "$BASE/api/admin/users" \
    -H "Authorization: Bearer $ADMIN_TOKEN" | head -c 400
  echo
else
  echo "FALHA: token administrativo não obtido"
fi

echo
echo "== login com senha errada (401) =="
curl -s -o /dev/null -w "status=%{http_code}\n" \
  -X POST "$BASE/api/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"ninguem@exemplo.com","password":"errada","type":"discente"}'

echo
echo "== cadastro sem campos (400) =="
curl -s -o /dev/null -w "status=%{http_code}\n" \
  -X POST "$BASE/api/register" \
  -H 'Content-Type: application/json' \
  -d '{}'

echo
echo "Log da function: $PROJECT_ROOT/.function-test.log"
