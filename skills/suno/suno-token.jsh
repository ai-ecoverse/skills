#!/usr/bin/env jsh
// Suno API — get auth token from browser session
// Usage: suno-token
// Returns the JWT token to stdout (for use in pipelines/subshells)

const DOMAIN = 'suno.com';

// Find a Suno tab
const list = await exec('playwright-cli tab-list');
const match = list.stdout.match(new RegExp(`\\[([A-F0-9]+)\\]\\s+https?://[^\\s]*${DOMAIN}`));
if (!match) {
  console.error('No suno.com tab found. Open suno.com in your browser and log in first.');
  process.exit(1);
}
const tabId = match[1];

// Extract JWT from Clerk
const result = await exec(`playwright-cli eval --tab=${tabId} "(async()=>{try{return await window.Clerk.session.getToken()}catch(e){return 'ERROR:'+e.message}})()"`);
const token = result.stdout.trim();

if (!token || token.startsWith('ERROR:') || token === 'null' || token === 'undefined') {
  console.error('Failed to get auth token. Make sure you are logged into suno.com.');
  if (token.startsWith('ERROR:')) console.error(token);
  process.exit(1);
}

console.log(token);
