#!/usr/bin/env bash
# Deploy to the purpl-crm-staging Firebase project.
# Swaps in the staging config, deploys, then always restores the production config.

set -euo pipefail

PROD_CONFIG="public/firebase-config.js"
STAGING_CONFIG="public/firebase-config.staging.js"
BACKUP_CONFIG="public/firebase-config.js.bak"

# Guard: staging config must exist and have real values
if grep -q "PASTE_STAGING_API_KEY_HERE" "$STAGING_CONFIG"; then
  echo "ERROR: $STAGING_CONFIG still has placeholder values."
  echo "Follow the setup instructions inside that file, then re-run."
  exit 1
fi

# Always restore the production config on exit (success or failure)
restore() {
  if [[ -f "$BACKUP_CONFIG" ]]; then
    mv "$BACKUP_CONFIG" "$PROD_CONFIG"
    echo "Production config restored."
  fi
}
trap restore EXIT

echo "→ Swapping in staging config..."
cp "$PROD_CONFIG" "$BACKUP_CONFIG"
cp "$STAGING_CONFIG" "$PROD_CONFIG"

echo "→ Deploying to staging (purpl-crm-staging)..."
firebase deploy --only hosting,firestore --project staging

echo "✓ Staging deploy complete."
