#!/usr/bin/env node
/**
 * deploy.js - Commits current state and deploys to Cloudflare Workers
 *
 * Usage: node deploy.js [commit message]
 *
 * This script ensures every deployment is preceded by a git commit,
 * so you can always roll back to a previous version by checking out
 * an older commit and re-deploying.
 */
const { execSync } = require('child_process');
const path = require('path');

function run(cmd, opts = {}) {
  try {
    const result = execSync(cmd, {
      cwd: path.resolve(__dirname),
      encoding: 'utf8',
      stdio: opts.silent ? 'pipe' : 'inherit',
      ...opts
    });
    return result;
  } catch (err) {
    if (opts.required === false) return null;
    console.error(`Command failed: ${cmd}`);
    console.error(err.message);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  const message = args[0] || `Deploy: ${new Date().toISOString()}`;

  // Check for uncommitted changes
  const status = run('git status --porcelain', { silent: true });
  if (!status || status.trim() === '') {
    console.log('No uncommitted changes to deploy.');
  } else {
    console.log('Staging changes...');
    run('git add -A');

    console.log(`Committing: ${message}`);
    run(`git commit -m "${message.replace(/"/g, '')}"`);
    console.log('✓ Changes committed.');
  }

  console.log('Deploying to Cloudflare Workers...');
  run('npx wrangler deploy');
  console.log('✓ Deployment complete!');
  console.log('');
  console.log('To rollback: git checkout <commit-hash> && npm run deploy');
}

main();
