#!/usr/bin/env bash
# Runs on the Oracle server (as ubuntu, via sudo). Idempotent: safe to re-run on every deploy.
# Expects the release tarball already extracted at /tmp/mdbeaver-release.
set -euo pipefail
REL=/tmp/mdbeaver-release

sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv rsync >/dev/null

id mdbeaver >/dev/null 2>&1 || sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin mdbeaver
sudo mkdir -p /opt/mdbeaver /var/www/mdbeaver /etc/mdbeaver

# Gateway code + venv
sudo rsync -a --delete "$REL/gateway/" /opt/mdbeaver/gateway/
[ -d /opt/mdbeaver/venv ] || sudo python3 -m venv /opt/mdbeaver/venv
sudo /opt/mdbeaver/venv/bin/pip install -q --upgrade pip
sudo /opt/mdbeaver/venv/bin/pip install -q -r /opt/mdbeaver/gateway/requirements.txt

# Secrets: generated once on the server, never leave it except via the owner.
if [ ! -f /etc/mdbeaver/gateway.env ]; then
  token=$(openssl rand -hex 32)
  sudo tee /etc/mdbeaver/gateway.env >/dev/null <<EOF
MDB_WORKER_TOKEN=$token
MDB_UPLOAD_DIR=/var/lib/mdbeaver/uploads
MDB_MAX_UPLOAD_MB=50
MDB_MAX_QUEUE=100
MDB_JOBS_PER_IP_PER_HOUR=30
MDB_RESULT_TTL_SEC=600
MDB_JOB_TIMEOUT_SEC=900
EOF
fi
sudo chown root:mdbeaver /etc/mdbeaver/gateway.env
sudo chmod 640 /etc/mdbeaver/gateway.env

# Static site (vendor libs shipped inside the release)
sudo rsync -a --delete --exclude node_modules --exclude package.json --exclude package-lock.json --exclude scripts "$REL/web/" /var/www/mdbeaver/
sudo chown -R root:root /var/www/mdbeaver
sudo find /var/www/mdbeaver -type d -exec chmod 755 {} + && sudo find /var/www/mdbeaver -type f -exec chmod 644 {} +

# Service
sudo cp "$REL/deploy/mdbeaver-gateway.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable mdbeaver-gateway >/dev/null 2>&1
# Files made before the service had UMask=0077 (it covers new ones).
sudo find /var/lib/mdbeaver -mindepth 1 -type d -exec chmod 700 {} + 2>/dev/null || true
sudo find /var/lib/mdbeaver -type f -exec chmod 600 {} + 2>/dev/null || true
sudo systemctl restart mdbeaver-gateway

# Coupon management command (coupons live in /var/lib/mdbeaver/coupons.json)
sudo install -m 755 "$REL/deploy/mdb-coupons" /usr/local/bin/mdb-coupons

# Nginx
sudo cp "$REL/deploy/nginx-mdbeaver.conf" /etc/nginx/sites-available/mdbeaver
sudo ln -sf /etc/nginx/sites-available/mdbeaver /etc/nginx/sites-enabled/mdbeaver
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx

sleep 2
systemctl is-active mdbeaver-gateway
curl -s http://127.0.0.1:8000/api/status && echo
