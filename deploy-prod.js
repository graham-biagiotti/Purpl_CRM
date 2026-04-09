#!/usr/bin/env node
// Cross-platform production deploy script.

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG = path.join(__dirname, 'public', 'firebase-config.js');
const content = fs.readFileSync(CONFIG, 'utf8');

// Hard stop if the staging config is in place
if (content.includes('purpl-crm-staging') || !content.includes('"purpl-crm"')) {
  console.error('');
  console.error('ERROR: firebase-config.js does not contain the production project ID.');
  console.error('The staging config may still be active. Fix it first:');
  console.error('');
  console.error('  git restore public/firebase-config.js');
  console.error('');
  console.error('Then re-run: npm run deploy:prod');
  console.error('');
  process.exit(1);
}

console.log('→ Config check passed (purpl-crm)');
console.log('→ Deploying to production (purpl-crm)...');
execSync('firebase deploy --only "hosting,firestore" --project default', { stdio: 'inherit' });
console.log('✓ Production deploy complete.');
