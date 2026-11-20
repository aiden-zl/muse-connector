#!/usr/bin/env bash
# One-command deploy of the Muse bridge to your Cloudflare account (free plan).
# Safe to re-run: reuses the existing D1 database, KV namespace and secrets.
set -euo pipefail
cd "$(dirname "$0")/.."

CFG_DIR="$HOME/.config/muse-bridge"
SECRETS="$CFG_DIR/secrets.json"
CONFIG="$CFG_DIR/config.json"
mkdir -p "$CFG_DIR"
chmod 700 "$CFG_DIR"
umask 077

W="npx --yes wrangler"

echo "==> 1/7 Cloudflare login"
if ! $W whoami 2>/dev/null | grep -q "You are logged in"; then
  $W login
fi

echo "==> 2/7 D1 database + KV namespace"
DB_ID=$($W d1 list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s);const d=l.find(x=>x.name==="muse-bridge");process.stdout.write(d?(d.uuid||d.id||""):"")}catch{}})')
if [ -z "$DB_ID" ]; then
  $W d1 create muse-bridge >/dev/null
  DB_ID=$($W d1 list --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s).find(x=>x.name==="muse-bridge");process.stdout.write(d.uuid||d.id)})')
fi
KV_ID=$($W kv namespace list 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const l=JSON.parse(s);const k=l.find(x=>x.title==="muse-bridge-oauth"||x.title.endsWith("muse-bridge-oauth"));process.stdout.write(k?k.id:"")}catch{}})')
if [ -z "$KV_ID" ]; then
  $W kv namespace create muse-bridge-oauth >/dev/null
  KV_ID=$($W kv namespace list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const k=JSON.parse(s).find(x=>x.title.endsWith("muse-bridge-oauth"));process.stdout.write(k.id)})')
fi
echo "    D1=$DB_ID KV=$KV_ID"

patch_config() { # $1 = MCP_RESOURCE (optional)
  DB_ID="$DB_ID" KV_ID="$KV_ID" RES="${1:-}" node -e '
    const fs=require("fs");let s=fs.readFileSync("wrangler.jsonc","utf8");
    s=s.replace(/("database_id":\s*")[^"]*(")/,`$1${process.env.DB_ID}$2`);
    s=s.replace(/("binding":\s*"OAUTH_KV",\s*"id":\s*")[^"]*(")/,`$1${process.env.KV_ID}$2`);
    if(process.env.RES) s=s.replace(/("MCP_RESOURCE":\s*")[^"]*(")/,`$1${process.env.RES}$2`);
    fs.writeFileSync("wrangler.jsonc",s);'
}
patch_config

echo "==> 3/7 Database migrations"
CI=1 $W d1 migrations apply DB --remote

echo "==> 4/7 Secrets"
if [ ! -f "$SECRETS" ]; then
  node -e '
    const c=require("crypto");
    const words=()=>Array.from({length:5},()=>c.randomBytes(4).toString("base64url").replace(/[-_]/g,"x").slice(0,5).toLowerCase()).join("-");
    const s={BRIDGE_PASSPHRASE:words(),ADMIN_TOKEN:c.randomBytes(32).toString("base64url"),KEYCHAIN_TOKEN:c.randomBytes(32).toString("base64url"),CRED_KEY:c.randomBytes(32).toString("base64")};
    require("fs").writeFileSync(process.argv[1],JSON.stringify(s,null,2),{mode:0o600});' "$SECRETS"
  echo "    generated new secrets in $SECRETS"
fi
TMP_SECRETS=$(mktemp -t musebridge).json
trap 'rm -f "$TMP_SECRETS"' EXIT
cp "$SECRETS" "$TMP_SECRETS"

# KEYCHAIN_TOKEN and a backup of CRED_KEY go into macOS Keychain via stdin (never argv)
node -e '
  const s=require(process.argv[1]);
  process.stdout.write(`add-generic-password -U -s muse-bridge-keychain-token -a muse-bridge -w ${s.KEYCHAIN_TOKEN}\n`+
    `add-generic-password -U -s muse-bridge-cred-key-backup -a muse-bridge -w ${s.CRED_KEY.replace(/[+/=]/g,m=>({"+":"-","/":"_","=":""})[m])}\n`);' "$SECRETS" | security -i >/dev/null 2>&1 || echo "    (could not write to Keychain; KEYCHAIN_TOKEN stays only in $SECRETS)"

echo "==> 5/7 First deploy (to learn the workers.dev URL)"
OUT=$($W deploy --secrets-file "$TMP_SECRETS" 2>&1 | grep -v -i secret | tee /dev/stderr)
URL=$(printf "%s" "$OUT" | grep -Eo 'https://[a-zA-Z0-9.-]+\.workers\.dev' | head -1)
if [ -z "$URL" ]; then echo "Could not find the workers.dev URL in deploy output. Enable workers.dev in the Cloudflare dashboard and re-run."; exit 1; fi

echo "==> 6/7 Redeploy with MCP_RESOURCE=$URL/mcp"
patch_config "$URL/mcp"
$W deploy --secrets-file "$TMP_SECRETS" >/dev/null
rm -f "$TMP_SECRETS"

echo "==> 7/7 Guardian config"
ADMIN=$(node -e 'process.stdout.write(require(process.argv[1]).ADMIN_TOKEN)' "$SECRETS")
URL="$URL" ADMIN="$ADMIN" node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({url:process.env.URL,admin_token:process.env.ADMIN},null,2),{mode:0o600})' "$CONFIG"
curl -fsS "$URL/health" >/dev/null && echo "    health check ok"

PASS=$(node -e 'process.stdout.write(require(process.argv[1]).BRIDGE_PASSPHRASE)' "$SECRETS")
cat <<EOF

================================================================
 Muse bridge is live.

 Connector URL (paste into Muse → Settings → Connectors → Add custom connector):
     $URL/mcp

 Passphrase (type it on the approval page Muse opens; shown once here,
 also stored in $SECRETS):
     $PASS

 Guardian CLI is configured: node guardian/cli.mjs status
================================================================
EOF
