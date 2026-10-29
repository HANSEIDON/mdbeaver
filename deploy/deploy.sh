#!/usr/bin/env bash
# Deploys gateway + web to the Oracle server. Run from the repo root in Git Bash:
#   bash deploy/deploy.sh
set -euo pipefail
HOST=${MDB_HOST:-ubuntu@129.225.173.48}
KEY=${MDB_SSH_KEY:-$HOME/.ssh/oracle-md.key}

[ -f web/vendor/pdf.min.mjs ] || { echo "web/vendor missing: run 'npm install && npm run vendor' in web/"; exit 1; }

tar --exclude=node_modules --exclude=__pycache__ --exclude=.env --exclude=.venv -czf /tmp/mdbeaver-release.tgz gateway web deploy
scp -i "$KEY" -q /tmp/mdbeaver-release.tgz "$HOST:/tmp/"
ssh -i "$KEY" "$HOST" 'rm -rf /tmp/mdbeaver-release && mkdir /tmp/mdbeaver-release && tar -xzf /tmp/mdbeaver-release.tgz -C /tmp/mdbeaver-release && bash /tmp/mdbeaver-release/deploy/remote-setup.sh; rm -rf /tmp/mdbeaver-release /tmp/mdbeaver-release.tgz'
rm -f /tmp/mdbeaver-release.tgz
