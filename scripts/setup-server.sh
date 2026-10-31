#!/usr/bin/env bash
# First-time production setup on a fresh Linux server (Ubuntu/Debian).
# Usage (from the repo folder):  sudo bash scripts/setup-server.sh pay.bizhubpay.com you@company.com "ชื่อคุณ"
# Installs Docker if missing, writes .env with fresh random secrets (never overwrites an existing .env),
# starts the gateway behind Caddy (automatic HTTPS) and creates the first admin account.
set -euo pipefail

DOMAIN="${1:-}"
ADMIN_EMAIL="${2:-}"
ADMIN_NAME="${3:-Admin}"
if [[ -z "$DOMAIN" || -z "$ADMIN_EMAIL" ]]; then
  echo "วิธีใช้: sudo bash scripts/setup-server.sh <โดเมน> <อีเมลแอดมิน> [ชื่อ]"
  echo "ตัวอย่าง: sudo bash scripts/setup-server.sh pay.bizhubpay.com you@company.com \"สมชาย\""
  exit 1
fi
cd "$(dirname "$0")/.."

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  echo "==> ติดตั้ง Docker"
  curl -fsSL https://get.docker.com | sh
fi

# 2. DNS must already point here, otherwise Caddy cannot get a certificate.
MY_IP="$(curl -fsS -4 https://api.ipify.org || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
echo "==> IP เครื่องนี้: ${MY_IP:-ไม่ทราบ}  |  $DOMAIN ชี้ไปที่: ${DNS_IP:-ยังไม่มี A record}"
if [[ -n "$MY_IP" && "$DNS_IP" != "$MY_IP" ]]; then
  echo "!! $DOMAIN ยังไม่ชี้มาที่เครื่องนี้ ให้เพิ่ม A record ($DOMAIN -> $MY_IP) แล้วรอสักครู่ค่อยรันใหม่"
  exit 1
fi

# 3. .env with fresh secrets
if [[ -f .env ]]; then
  echo "==> มีไฟล์ .env อยู่แล้ว ใช้ค่าเดิม (ไม่เขียนทับ)"
else
  echo "==> สร้างไฟล์ .env"
  cp .env.example .env
  set_env() { sed -i "s|^$1=.*|$1=$2|" .env; }
  set_env DOMAIN "$DOMAIN"
  set_env PUBLIC_BASE_URL "https://$DOMAIN"
  set_env ADMIN_TOKEN "$(openssl rand -hex 32)"
  set_env ADMIN_REQUIRE_2FA true
  chmod 600 .env
fi

# 4. Start
echo "==> เริ่มระบบ (ครั้งแรกใช้เวลา 1-3 นาที)"
docker compose up -d --build

for _ in $(seq 1 30); do
  if docker compose exec -T gateway node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then break; fi
  sleep 2
done

# 5. First admin (skipped if the email already exists)
echo "==> สร้างบัญชีแอดมิน $ADMIN_EMAIL"
docker compose exec -T gateway node --import tsx scripts/create-admin.ts --email "$ADMIN_EMAIL" --name "$ADMIN_NAME" \
  || echo "(ข้ามขั้นนี้ อาจมีบัญชีนี้อยู่แล้ว)"

echo
echo "เสร็จแล้ว เปิด https://$DOMAIN/admin/console แล้วเข้าด้วยอีเมลและรหัสผ่านชั่วคราวด้านบน"
echo "ระบบจะให้ตั้งรหัสผ่านใหม่และตั้ง 2FA ก่อนเริ่มใช้งาน"
echo "ADMIN_TOKEN อยู่ในไฟล์ .env บนเครื่องนี้ (cat .env | grep ADMIN_TOKEN) เก็บไว้ใช้ฉุกเฉินเท่านั้น"
