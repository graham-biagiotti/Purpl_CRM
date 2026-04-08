#!/usr/bin/env node
// Cross-platform staging deploy script (works on Windows, Mac, Linux).
// Swaps in the staging Firebase config, deploys, then always restores production config.

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROD    = path.join(__dirname, 'public', 'firebase-config.js');
const STAGING = path.join(__dirname, 'public', 'firebase-config.staging.js');
const BACKUP  = path.join(__dirname, 'public', 'firebase-config.js.bak');

function restore() {
  if (fs.existsSync(BACKUP)) {
    fs.copyFileSync(BACKUP, PROD);
    fs.unlinkSync(BACKUP);
    console.log('Production config restored.');
  }
}

// Guard: staging config must have real values
const stagingContent = fs.readFileSync(STAGING, 'utf8');
if (stagingContent.includes('PASTE_STAGING_API_KEY_HERE')) {
  console.error('ERROR: firebase-config.staging.js still has placeholder values.');
  process.exit(1);
}

// Register restore on any exit
process.on('exit', restore);
process.on('SIGINT',  () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));

try {
  console.log('→ Swapping in staging config...');
  fs.copyFileSync(PROD, BACKUP);
  fs.copyFileSync(STAGING, PROD);

  console.log('→ Deploying to staging (purpl-crm-staging)...');
  execSync('firebase deploy --only "hosting,firestore,functions" --project staging', { stdio: 'inherit' });

  console.log('✓ Staging deploy complete.');
} catch (err) {
  console.error('Deploy failed:', err.message);
  process.exit(1);
}
