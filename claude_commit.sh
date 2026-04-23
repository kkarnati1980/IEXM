#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# claude_commit.sh
#
# Run this after every Claude session to commit and push whatever
# fix files Claude produced.
#
# Usage:
#   ./claude_commit.sh "SP-05 enrichment pipeline" [path/to/fixes/dir]
#
# If no fixes dir is given, looks in ~/Downloads by default.
# ─────────────────────────────────────────────────────────────────────────────

set -e

REPO_DIR="/Users/kishore/Codex_Development"
PAT="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"
REMOTE_WITH_AUTH="https://kkarnati1980:${PAT}@github.com/kkarnati1980/IEXM.git"

COMMIT_MSG="${1:-chore: apply Claude session fixes}"
FIXES_DIR="${2:-$HOME/Downloads}"

echo ""
echo "╔════════════════════════════════════════════╗"
echo "║  Claude Commit Helper                      ║"
echo "╚════════════════════════════════════════════╝"
echo "  Message : $COMMIT_MSG"
echo "  Fixes   : $FIXES_DIR"
echo ""

cd "$REPO_DIR"

# Ensure remote is set with auth
git remote set-url origin "$REMOTE_WITH_AUTH" 2>/dev/null || true

# Pull latest first
echo "── Pulling latest from origin/main ──"
git pull origin main --no-rebase 2>&1 || echo "  Nothing to pull"

# Copy fix files from fixes dir to their destinations
echo ""
echo "── Copying fix files ──"

copy_if_exists() {
  local src="$1" dst="$2"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
    echo "  ✓ $dst"
  fi
}

copy_if_exists "$FIXES_DIR/kiosk.html"              "apps/web/kiosk.html"
copy_if_exists "$FIXES_DIR/sponsor.html"            "apps/web/sponsor.html"
copy_if_exists "$FIXES_DIR/organizer.html"          "apps/web/organizer.html"
copy_if_exists "$FIXES_DIR/033_branding_assets.sql" "apps/api/migrations/033_branding_assets.sql"
copy_if_exists "$FIXES_DIR/034_webhook_tables.sql"  "apps/api/migrations/034_webhook_tables.sql"
copy_if_exists "$FIXES_DIR/routes_patch_final.mjs"  "apps/api/src/routes_patch_final.mjs"

# Merge routes patch if present
if [ -f "$FIXES_DIR/routes_patch_final.mjs" ] && [ -f "apps/api/src/routes.mjs" ]; then
  echo "  ── Merging routes patch into routes.mjs ──"
  cp "apps/api/src/routes.mjs" "apps/api/src/routes.mjs.bak"
  PATCH="$FIXES_DIR/routes_patch_final.mjs"
  python3 << PYEOF
with open("apps/api/src/routes.mjs") as f: orig = f.read()
with open("$PATCH") as f: patch = f.read()
lines = patch.split("\n")
start = next((i for i,l in enumerate(lines) if l.strip().startswith("app.")), 0)
new_routes = "\n".join(lines[start:])
idx = orig.rfind("\n}")
if idx == -1: idx = len(orig)
merged = orig[:idx] + "\n\n" + new_routes + "\n" + orig[idx:]
with open("apps/api/src/routes.mjs","w") as f: f.write(merged)
print("    Routes merged OK")
PYEOF
fi

# Stage and commit
echo ""
echo "── Committing ──"
git add .

if git diff --cached --quiet; then
  echo "  Nothing to commit — all files already up to date"
else
  git commit -m "$COMMIT_MSG"
  echo "  ✓ Committed"
fi

# Push
echo ""
echo "── Pushing ──"
git push origin main
echo "  ✓ Pushed to origin/main"

echo ""
echo "✅ Done — https://github.com/kkarnati1980/IEXM"
echo ""
