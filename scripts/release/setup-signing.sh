#!/bin/bash
# One-time setup of Daylight's release signing material on the release machine.
#  1. A 10-year self-signed code-signing certificate "Daylight Release Code Signing" in a dedicated
#     keychain (never the login keychain).
#  2. An Ed25519 key pair that signs update manifests.
# Secrets are written with mode 600 and are never printed. Existing material is never overwritten.
set -euo pipefail
umask 077
DIR="${DAYLIGHT_SIGNING_DIR:-$HOME/.daylight-signing}"
KEYCHAIN="$DIR/release.keychain-db"
PASSWORD_FILE="$DIR/keychain-password"
NAME="Daylight Release Code Signing"
mkdir -p "$DIR"; chmod 700 "$DIR"

if [ -e "$KEYCHAIN" ] || [ -e "$DIR/update-ed25519.pem" ]; then
  echo "签名材料已存在于 ${DIR}，未做任何修改。如需轮换，请先人工备份并移走旧文件。" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/daylight-signing.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# Keychain password: random, stored only in a 600 file.
head -c 32 /dev/urandom | base64 | tr -d '\n=/+' | head -c 40 > "$PASSWORD_FILE"
chmod 600 "$PASSWORD_FILE"
PASSWORD="$(cat "$PASSWORD_FILE")"

# Use the system LibreSSL: its PKCS#12 output is what `security import` accepts.
OPENSSL=/usr/bin/openssl
cat > "$WORK/cert.cnf" <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
O = Daylight
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
CNF
"$OPENSSL" req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes -config "$WORK/cert.cnf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
P12_PASSWORD="$(head -c 24 /dev/urandom | base64 | tr -d '\n=/+')"
"$OPENSSL" pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" -out "$WORK/identity.p12" -passout "pass:$P12_PASSWORD"

security create-keychain -p "$PASSWORD" "$KEYCHAIN"
# No auto-lock: unattended release builds must not stall on a locked keychain.
security set-keychain-settings "$KEYCHAIN"
security unlock-keychain -p "$PASSWORD" "$KEYCHAIN"
security import "$WORK/identity.p12" -k "$KEYCHAIN" -P "$P12_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security >/dev/null
# Let codesign use the key without an interactive prompt.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PASSWORD" "$KEYCHAIN" >/dev/null

cp "$WORK/cert.pem" "$DIR/release-cert.pem"; chmod 644 "$DIR/release-cert.pem"
SHA1="$("$OPENSSL" x509 -in "$WORK/cert.pem" -noout -fingerprint -sha1 | sed 's/.*=//; s/://g')"
printf '%s\n' "$SHA1" > "$DIR/release-cert.sha1"; chmod 644 "$DIR/release-cert.sha1"

# Ed25519 update-signing key pair. The private half stays here; the public half is committed.
node --input-type=module - "$DIR" <<'NODE'
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, chmodSync } from 'node:fs';
const dir = process.argv[2];
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
writeFileSync(`${dir}/update-ed25519.pem`, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
chmodSync(`${dir}/update-ed25519.pem`, 0o600);
const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
writeFileSync(`${dir}/update-ed25519.pub`, raw + '\n', { mode: 0o644 });
NODE

echo "证书 SHA-1: ${SHA1}"
echo "钥匙串: ${KEYCHAIN}（密码文件 ${PASSWORD_FILE}，权限 600）"
echo "更新公钥 (base64, 可提交): $(cat "$DIR/update-ed25519.pub")"
