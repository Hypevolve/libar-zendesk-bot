#!/usr/bin/env bash

set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "Usage: ./scripts/render-zendesk-ticket-openapi.sh <zendesk-subdomain>" >&2
  exit 1
fi

SUBDOMAIN="$1"
TEMPLATE="docs/copilot/zendesk-ticket-custom-connector.yaml"
OUTPUT_DIR="dist"
OUTPUT_FILE="$OUTPUT_DIR/zendesk-ticket-custom-connector.$SUBDOMAIN.yaml"

mkdir -p "$OUTPUT_DIR"
sed "s/YOUR_ZENDESK_SUBDOMAIN/$SUBDOMAIN/g" "$TEMPLATE" > "$OUTPUT_FILE"

echo "Generated: $OUTPUT_FILE"
