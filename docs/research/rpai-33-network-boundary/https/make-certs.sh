#!/bin/sh
# Throwaway certificates for the HTTPS spike. Nothing here is a real credential; run it again for fresh ones.
# Writes into ./certs (ignored by git): an "engine" authority and one leaf key for the proxy, and a "public"
# authority with certificates for the pretend customer sites.
set -e
mkdir -p "$(dirname "$0")/certs" && cd "$(dirname "$0")/certs"
ec() { openssl ecparam -name prime256v1 -genkey -noout -out "$1"; }
ec engine-ca.key
openssl req -x509 -new -key engine-ca.key -days 2 -subj "/CN=spike engine CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign" -out engine-ca.pem
ec leaf.key
ec target-ca.key
openssl req -x509 -new -key target-ca.key -days 2 -subj "/CN=spike target CA" -addext "basicConstraints=critical,CA:TRUE" -out target-ca.pem
ec target.key
for h in shop.test app.test widget.test; do
  openssl req -new -key target.key -subj "/CN=$h" -out "$h.csr"
  printf "subjectAltName=DNS:%s\nextendedKeyUsage=serverAuth\n" "$h" > "$h.ext"
  openssl x509 -req -in "$h.csr" -CA target-ca.pem -CAkey target-ca.key -CAcreateserial -days 2 -extfile "$h.ext" -out "$h.pem"
done
# A site whose certificate is not from the "public" authority, for the negative test.
openssl req -x509 -new -key target.key -days 2 -subj "/CN=evil.test" -addext "subjectAltName=DNS:evil.test" -out evil.test.pem
openssl pkey -in leaf.key -pubout -outform DER | openssl dgst -sha256 -binary | base64 > leaf.spki
