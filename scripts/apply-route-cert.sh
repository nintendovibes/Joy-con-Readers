#!/usr/bin/env bash
# Attaches the *.nintendovibes.com certificate (from make-nintendovibes-cert.sh)
# to OpenShift Routes, so Chrome trusts those sites. Needs `oc` logged in.
#
#   bash scripts/apply-route-cert.sh [route ...]     (default: joycon-reader)
#
# The key never goes into git. If Argo CD manages a Route with self-heal on,
# tell it to ignore these fields or it will strip them (see README.md).
set -euo pipefail
NS="${NS:-nintendo}"
DIR="${CERT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)/nintendovibes-certs}"
ROUTES=("$@"); [ ${#ROUTES[@]} -eq 0 ] && ROUTES=(joycon-reader)

for f in nintendovibes.crt nintendovibes.key nintendovibes-ca.crt; do
  [ -f "$DIR/$f" ] || { echo "Missing $DIR/$f - run scripts/make-nintendovibes-cert.sh first"; exit 1; }
done

# JSON-escape a PEM file for oc patch: drop carriage returns, and turn each
# line ending into the two characters \n.
pem() { tr -d '\r' < "$1" | awk '{ printf "%s\\n", $0 }'; }

for route in "${ROUTES[@]}"; do
  echo "Attaching certificate to route/$route in $NS"
  oc -n "$NS" patch route "$route" --type=merge -p "{\"spec\":{\"tls\":{\"certificate\":\"$(pem "$DIR/nintendovibes.crt")\",\"key\":\"$(pem "$DIR/nintendovibes.key")\",\"caCertificate\":\"$(pem "$DIR/nintendovibes-ca.crt")\"}}}"
done
