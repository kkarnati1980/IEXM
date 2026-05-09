#!/usr/bin/env bash
# Claude Code skill installer
# Scans source directories for skill folders (dirs containing SKILL.md),
# installs new ones to ~/.claude/skills/, and optionally commits them
# into a target repo's .claude/skills/ directory.

set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────────────
CLAUDE_SKILLS_DIR="${HOME}/.claude/skills"
REPO_TARGET=""          # set via --repo flag; empty = skip repo install

# Default source locations to scan
DEFAULT_SOURCES=(
  "${HOME}/Documents"
  "${HOME}/Downloads"
  "${HOME}"
)

# ── Helpers ─────────────────────────────────────────────────────────────────
red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
cyan()  { printf '\033[0;36m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

usage() {
  cat <<EOF
Usage: $(basename "$0") [OPTIONS] [SOURCE_DIR ...]

Scans SOURCE_DIR(s) for Claude Code skill folders (containing SKILL.md),
then installs them into ~/.claude/skills/ without overwriting existing ones.

Options:
  --repo PATH     Also copy new skills into PATH/.claude/skills/ and commit them
  --dry-run       Show what would be installed without doing anything
  --list          List installed skills and exit
  -h, --help      Show this help

Examples:
  $(basename "$0")                          # scan default locations
  $(basename "$0") ~/my-skills-repo         # scan a specific folder
  $(basename "$0") --repo ~/myproject       # also commit into a repo
  $(basename "$0") --dry-run                # preview without installing
EOF
  exit 0
}

# ── Argument parsing ─────────────────────────────────────────────────────────
DRY_RUN=false
LIST_ONLY=false
SOURCES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)      REPO_TARGET="$2"; shift 2 ;;
    --dry-run)   DRY_RUN=true; shift ;;
    --list)      LIST_ONLY=true; shift ;;
    -h|--help)   usage ;;
    -*)          red "Unknown option: $1"; usage ;;
    *)           SOURCES+=("$1"); shift ;;
  esac
done

# Fall back to defaults if no sources given
if [[ ${#SOURCES[@]} -eq 0 ]]; then
  SOURCES=("${DEFAULT_SOURCES[@]}")
fi

# ── List mode ────────────────────────────────────────────────────────────────
if $LIST_ONLY; then
  bold "Installed skills in ${CLAUDE_SKILLS_DIR}:"
  if [[ ! -d "$CLAUDE_SKILLS_DIR" ]] || [[ -z "$(ls -A "$CLAUDE_SKILLS_DIR" 2>/dev/null)" ]]; then
    echo "  (none)"
  else
    for d in "${CLAUDE_SKILLS_DIR}"/*/; do
      name=$(basename "$d")
      desc=$(grep -m1 '^description:' "${d}SKILL.md" 2>/dev/null | sed 's/description: //' | tr -d '"' || echo "(no description)")
      printf '  %-30s %s\n' "$name" "$desc"
    done
  fi
  exit 0
fi

# ── Discover skill folders ────────────────────────────────────────────────────
bold "Scanning for skill folders..."
declare -A found_skills   # name -> path

for src in "${SOURCES[@]}"; do
  [[ -d "$src" ]] || continue
  # Search up to 5 levels deep for directories containing SKILL.md
  while IFS= read -r skill_md; do
    skill_dir=$(dirname "$skill_md")
    skill_name=$(basename "$skill_dir")
    # Avoid picking up the already-installed skills dir itself
    if [[ "$skill_dir" == "${CLAUDE_SKILLS_DIR}"* ]]; then
      continue
    fi
    found_skills["$skill_name"]="$skill_dir"
  done < <(find "$src" -maxdepth 5 -name "SKILL.md" 2>/dev/null)
done

set +u
skill_count="${#found_skills[@]}"
set -u
if [[ -z "$skill_count" ]] || [[ "$skill_count" -eq 0 ]]; then
  cyan "No skill folders found in: ${SOURCES[*]}"
  echo "A skill folder is any directory containing a SKILL.md file."
  exit 0
fi

echo "Found ${skill_count} skill(s) in source locations."

# ── Install to ~/.claude/skills/ ─────────────────────────────────────────────
mkdir -p "$CLAUDE_SKILLS_DIR"

installed=0
skipped=0
declare -a newly_installed=()

bold "\nInstalling to ${CLAUDE_SKILLS_DIR}:"
for skill_name in "${!found_skills[@]}"; do
  skill_src="${found_skills[$skill_name]}"
  skill_dest="${CLAUDE_SKILLS_DIR}/${skill_name}"

  if [[ -d "$skill_dest" ]]; then
    printf '  %-30s %s\n' "$skill_name" "$(cyan 'already installed — skipped')"
    (( skipped++ )) || true
  else
    if $DRY_RUN; then
      printf '  %-30s %s\n' "$skill_name" "[DRY RUN] would install from ${skill_src}"
    else
      cp -r "$skill_src" "$skill_dest"
      printf '  %-30s %s\n' "$skill_name" "$(green 'installed')"
      newly_installed+=("$skill_name")
    fi
    (( installed++ )) || true
  fi
done

# ── Install into repo's .claude/skills/ ─────────────────────────────────────
if [[ -n "$REPO_TARGET" ]]; then
  if [[ ! -d "$REPO_TARGET/.git" ]]; then
    red "Warning: ${REPO_TARGET} does not appear to be a git repo — skipping repo install."
  else
    REPO_SKILLS="${REPO_TARGET}/.claude/skills"
    mkdir -p "$REPO_SKILLS"

    bold "\nInstalling into repo ${REPO_TARGET}/.claude/skills/:"
    repo_added=0
    for skill_name in "${!found_skills[@]}"; do
      skill_src="${found_skills[$skill_name]}"
      skill_dest="${REPO_SKILLS}/${skill_name}"

      if [[ -d "$skill_dest" ]]; then
        printf '  %-30s %s\n' "$skill_name" "$(cyan 'already in repo — skipped')"
      else
        if $DRY_RUN; then
          printf '  %-30s %s\n' "$skill_name" "[DRY RUN] would copy to repo"
        else
          cp -r "$skill_src" "$skill_dest"
          printf '  %-30s %s\n' "$skill_name" "$(green 'copied')"
          (( repo_added++ )) || true
        fi
      fi
    done

    if ! $DRY_RUN && [[ $repo_added -gt 0 ]]; then
      bold "\nCommitting skills to repo..."
      git -C "$REPO_TARGET" add ".claude/skills/"
      git -C "$REPO_TARGET" commit -m "Add Claude Code skills: ${newly_installed[*]}"
      green "Committed ${repo_added} skill(s) to ${REPO_TARGET}"
    fi
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
bold "Summary:"
if $DRY_RUN; then
  echo "  Dry run — no changes made."
  echo "  Would install: ${installed} skill(s), skip: ${skipped} already present."
else
  green "  Installed: ${installed}   Skipped (already present): ${skipped}"
fi
echo ""
echo "Run '$(basename "$0") --list' to see all installed skills."
