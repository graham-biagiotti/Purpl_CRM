#!/usr/bin/env node
// Cross-platform production deploy script.

const { execSync } = require('child_process');

console.log('→ Deploying to production (purpl-crm)...');
execSync('firebase deploy --only "hosting,firestore" --project default', { stdio: 'inherit' });
console.log('✓ Production deploy complete.');
