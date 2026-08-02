# Development Workflow

## Git-Based Deployments

**Always use `npm run deploy` instead of `npx wrangler deploy` directly.**

The `npm run deploy` command runs:
1. `npm run build:css` (rebuilds Tailwind CSS output)
2. `node deploy.js` which:
   - Checks for uncommitted changes
   - Commits all changes with a timestamped message
   - Runs `npx wrangler deploy`

This ensures every deployment is preceded by a git commit, allowing rollback via:
```bash
git checkout <commit-hash>
npm run deploy
```

## Deployment Commands

| Command | Description |
|--------|-------------|
| `npm run deploy` | Full deploy: build CSS + auto-commit + upload to CF |
| `npm run deploy:fast` | Skip CSS rebuild: auto-commit + upload to CF only |
| `node deploy.js "message"` | Auto-commit with custom message + deploy |

## Recovery Workflow

If something breaks after deployment:
1. `git log` to see recent commits
2. `git checkout <commit-hash>` to restore working files
3. `npm run deploy` to push the restored version to Cloudflare

## Project Structure

- `worker.js` — Cloudflare Worker handler (main backend)
- `public/` — Static assets (HTML, CSS, images)
- `wrangler.toml` — Cloudflare Worker configuration
- `deploy.js` — Auto-commit + deploy script
- `public/css/tailwind-input.css` — Tailwind CSS source
- `public/css/tailwind.css` — Compiled Tailwind output
