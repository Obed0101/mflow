#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

failures=0

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  failures=$((failures + 1))
}

require_file() {
  [[ -f "$1" ]] || fail "missing required file: $1"
}

printf '== mflow public release check ==\n'
printf 'root: %s\n\n' "$ROOT"

printf '== Required governance files ==\n'
required_files=(
  .npmignore
  LICENSE
  SECURITY.md
  CONTRIBUTING.md
  .github/pull_request_template.md
  .github/ISSUE_TEMPLATE/bug_report.md
  .github/ISSUE_TEMPLATE/feature_request.md
)
for file in "${required_files[@]}"; do
  require_file "$file"
  [[ -f "$file" ]] && printf 'ok %s\n' "$file"
done
printf '\n'

printf '== Forbidden tracked files ==\n'
forbidden_regex='(^|/)(\.mflow|\.agents|\.claude)(/|$)|(^|/)\.mcp\.json$|\.tsbuildinfo$|\.tmp$|\.temp$|\.bun-build$|\.ystate$|(^|/).*\.pid$|(^|/).*\.sock$|(^|/)CLAUDE\.md$'
tracked_hits="$(git ls-files | grep -E "$forbidden_regex" || true)"
if [[ -n "$tracked_hits" ]]; then
  printf '%s\n' "$tracked_hits"
  fail 'forbidden files are tracked by git'
else
  printf 'ok no forbidden tracked files\n'
fi
printf '\n'

printf '== Forbidden untracked files in working tree ==\n'
untracked_hits="$(git ls-files --others --exclude-standard | grep -E "$forbidden_regex" || true)"
if [[ -n "$untracked_hits" ]]; then
  printf '%s\n' "$untracked_hits"
  fail 'forbidden untracked files exist; keep them ignored or remove before release'
else
  printf 'ok no forbidden untracked files visible to git\n'
fi
printf '\n'

printf '== Package naming sanity ==\n'
root_name="$(node -e "console.log(require('./package.json').name)")"
if [[ "$root_name" != "mflow-sdk" ]]; then
  fail "root package name should be mflow-sdk for the initial public package, got: $root_name"
else
  printf 'ok root package name: %s\n' "$root_name"
fi
if ! node -e "const pkg=require('./package.json'); process.exit(pkg.bin && pkg.bin.mflow ? 0 : 1)"; then
  fail 'root package.json must expose the mflow CLI binary for package dry-runs'
else
  printf 'ok root package exposes mflow binary\n'
fi
printf '\n'

printf '== Secret scan triage reminder ==\n'
printf 'Run and triage manually before public release:\n'
printf 'grep -RInE "(api[_-]?key|secret|token|password|BEGIN .*PRIVATE KEY|sk-|ghp_|github_pat_)" --exclude-dir=node_modules --exclude-dir=.git .\n\n'

printf '== npm pack forbidden-path check ==\n'
pack_output="$(npm pack --dry-run 2>&1 || true)"
pack_hits="$(printf '%s\n' "$pack_output" | grep -E "$forbidden_regex" || true)"
if [[ -n "$pack_hits" ]]; then
  printf '%s\n' "$pack_hits"
  fail 'npm pack dry-run includes forbidden release paths'
else
  printf 'ok npm pack dry-run excludes forbidden paths\n'
fi
printf '\n'

if (( failures > 0 )); then
  printf 'public release check failed with %d issue(s).\n' "$failures" >&2
  exit 1
fi

printf 'public release check passed.\n'
