#!/usr/bin/env bash
set -euo pipefail
# Source this trusted local file before invoking a command; never use in production.
if [[ ! -f .env ]]; then
  echo 'Copy .env.example to .env first.' >&2
  return 1 2>/dev/null || exit 1
fi
set -a
source .env
set +a
