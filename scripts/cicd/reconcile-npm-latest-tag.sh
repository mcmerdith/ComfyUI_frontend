#!/usr/bin/env bash
set -euo pipefail

: "${PACKAGE:?PACKAGE is required}"

readonly STABLE_SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'

summary() {
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] && printf '%s\n' "$@" >>"$GITHUB_STEP_SUMMARY"
  return 0
}

versions_json=$(npm view "$PACKAGE" versions --json)

mapfile -t stable_versions < <(
  {
    grep -oE '"[^"]+"' <<<"$versions_json" | tr -d '"'
    printf '%s\n' "${VERSION:-}"
  } | grep -E "$STABLE_SEMVER" || true
)

if [[ ${#stable_versions[@]} -eq 0 ]]; then
  echo "::warning::No stable versions of $PACKAGE found; leaving the latest dist-tag unchanged."
  exit 0
fi

highest=$(printf '%s\n' "${stable_versions[@]}" | sort -V | tail -1)
current=$(npm view "$PACKAGE" dist-tags.latest)

echo "Highest stable version: $highest — npm latest: ${current:-<none>}"

if [[ "$current" == "$highest" ]]; then
  echo "OK: latest already points at the highest stable version."
  exit 0
fi

echo "::warning::latest is '${current:-<none>}' but the highest stable version is '$highest'; reassigning."
npm dist-tag add "$PACKAGE@$highest" latest

summary "## npm latest dist-tag auto-correction" "" \
  "- Package: \`$PACKAGE\`" \
  "- Previously tagged \`latest\`: \`${current:-<none>}\`" \
  "- Reassigned \`latest\` to: \`$highest\`"
