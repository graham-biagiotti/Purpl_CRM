#!/usr/bin/env bash
# Deploy to the purpl-crm production Firebase project.

set -euo pipefail

echo "→ Deploying to production (purpl-crm)..."
firebase deploy --only hosting,firestore --project default

echo "✓ Production deploy complete."
