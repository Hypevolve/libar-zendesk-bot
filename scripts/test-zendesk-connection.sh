#!/usr/bin/env bash

set -euo pipefail

if [[ -z "${ZENDESK_SUBDOMAIN:-}" || -z "${ZENDESK_EMAIL:-}" || -z "${ZENDESK_API_TOKEN:-}" ]]; then
  cat <<'EOF'
Missing required environment variables.

Set these before running:
  export ZENDESK_SUBDOMAIN="antikvarijat-libar"
  export ZENDESK_EMAIL="bojan.vukas@antikvarijat-libar.com"
  export ZENDESK_API_TOKEN="YOUR_API_TOKEN"

Optional:
  export REQUESTER_NAME="Test Korisnik"
  export REQUESTER_EMAIL="test@example.com"
  export TICKET_SUBJECT="Test from custom connector"
  export TICKET_BODY="Test ticket body"
EOF
  exit 1
fi

REQUESTER_NAME="${REQUESTER_NAME:-Test Korisnik}"
REQUESTER_EMAIL="${REQUESTER_EMAIL:-test@example.com}"
TICKET_SUBJECT="${TICKET_SUBJECT:-Test from custom connector}"
TICKET_BODY="${TICKET_BODY:-Test ticket body}"

BASE_URL="https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2"
AUTH="${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}"

echo "1) Checking API auth with /users/me.json ..."
curl --silent --show-error --fail \
  -u "${AUTH}" \
  "${BASE_URL}/users/me.json" >/tmp/zendesk-me.json
echo "   OK: authentication works."

echo "2) Creating test ticket ..."
HTTP_CODE=$(curl --silent --show-error \
  -o /tmp/zendesk-ticket-create.json \
  -w "%{http_code}" \
  -u "${AUTH}" \
  -H "Content-Type: application/json" \
  -X POST \
  "${BASE_URL}/tickets.json" \
  -d @- <<EOF
{
  "ticket": {
    "subject": "${TICKET_SUBJECT}",
    "comment": { "body": "${TICKET_BODY}", "public": true },
    "requester": { "name": "${REQUESTER_NAME}", "email": "${REQUESTER_EMAIL}" },
    "priority": "normal",
    "status": "new",
    "tags": ["copilot_studio", "libar", "integration_test"]
  }
}
EOF
)

if [[ "${HTTP_CODE}" != "201" && "${HTTP_CODE}" != "200" ]]; then
  echo "   ERROR: ticket create failed with HTTP ${HTTP_CODE}"
  echo "   Response:"
  cat /tmp/zendesk-ticket-create.json
  exit 1
fi

echo "   OK: ticket created (HTTP ${HTTP_CODE})."
echo "   Response saved at /tmp/zendesk-ticket-create.json"
