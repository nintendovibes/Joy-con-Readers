#!/usr/bin/env bash
# Creates the HTTPS certificate for every *.nintendovibes.com site, so Chrome
# treats them as trusted secure pages (Web Bluetooth and WebHID need that).
#
#   bash scripts/make-nintendovibes-cert.sh [output-dir]
#
# Default output: ../../nintendovibes-certs (next to the projects, outside
# every git repo):
#   nintendovibes-ca.crt   "Nintendo Vibes CA": trust this once on the Mac / iPad
#   nintendovibes-ca.key   CA private key: keep it on this PC, never share
#   nintendovibes.crt/.key the site certificate, attached to the OpenShift Routes
#
# The CA carries name constraints, so it can only vouch for nintendovibes.com
# and its subdomains; trusting it can't let it impersonate any other site.
# Re-running reuses the CA and issues a fresh site certificate (it lasts 825
# days, the longest Apple devices accept).
set -euo pipefail
export MSYS_NO_PATHCONV=1   # stop Git Bash rewriting "/CN=..." into a path

DIR="${1:-$(cd "$(dirname "$0")/../.." && pwd)/nintendovibes-certs}"
mkdir -p "$DIR"
cd "$DIR"

if [ ! -f nintendovibes-ca.key ]; then
  cat > ca.cnf <<CNF
[req]
distinguished_name = dn
x509_extensions = ca_ext
prompt = no
[dn]
CN = Nintendo Vibes CA
O = Nintendo NFC (home network)
[ca_ext]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:nintendovibes.com
CNF
  openssl req -x509 -new -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -keyout nintendovibes-ca.key -out nintendovibes-ca.crt -config ca.cnf
fi

cat > site.cnf <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = *.nintendovibes.com
[site_ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:*.nintendovibes.com, DNS:nintendovibes.com
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF
openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -keyout nintendovibes.key -out nintendovibes.csr -config site.cnf
openssl x509 -req -in nintendovibes.csr -CA nintendovibes-ca.crt -CAkey nintendovibes-ca.key \
  -CAcreateserial -days 825 -sha256 -extfile site.cnf -extensions site_ext -out nintendovibes.crt
rm -f nintendovibes.csr

echo
echo "Done: $DIR"
openssl x509 -in nintendovibes.crt -noout -subject -enddate -ext subjectAltName
openssl verify -CAfile nintendovibes-ca.crt nintendovibes.crt
