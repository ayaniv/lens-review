#!/usr/bin/env bash
# Writes the diff under review into a fresh per-run dir (diff.patch, files.txt, base.txt and
# base-tip.txt)
# and prints that dir as the last stdout line. A per-run dir, not a fixed /tmp path, so two
# concurrent reviews can never overwrite each other's diff. base.txt is the commit the PR
# branched from: casting reads the repo there, so the PR's own code never shapes the team.
# base-tip.txt is the base branch as it is now, which can be ahead of base.txt: the
# migration-order precheck reads what has merged since the branch was cut.
#
#   gather-diff.sh [--base <ref>]     diff <ref>...HEAD of the repo in the cwd (default: the
#                                     remote's default branch, else a local main, else master)
#   gather-diff.sh --diff <patch>     review an existing patch file (e.g. saved from `gh pr diff`)
set -euo pipefail

fail() {
  echo "lens-review: $*" >&2
  exit 1
}

default_base_ref() {
  local remote_default
  if remote_default="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2> /dev/null)"; then
    echo "$remote_default"
    return
  fi
  for candidate in main master; do
    if git rev-parse --verify --quiet "$candidate" > /dev/null; then
      echo "$candidate"
      return
    fi
  done
  fail "no base branch found (no origin/HEAD, main or master) — pass --base <ref>"
}

base_ref=""
patch_path=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base) base_ref="${2:?--base needs a ref}"; shift 2 ;;
    --diff) patch_path="${2:?--diff needs a patch file}"; shift 2 ;;
    *) fail "unknown argument: $1" ;;
  esac
done

git rev-parse --git-dir > /dev/null 2>&1 || fail "not a git repository: $(pwd)"
[[ -n "$base_ref" ]] || base_ref="$(default_base_ref)"
git rev-parse --verify --quiet "$base_ref" > /dev/null || fail "base ref not found: $base_ref"

run_dir="$(mktemp -d "${TMPDIR:-/tmp}/lens-review.XXXXXX")"
git merge-base "$base_ref" HEAD > "$run_dir/base.txt" || fail "no common ancestor between $base_ref and HEAD"
git rev-parse "$base_ref^{commit}" > "$run_dir/base-tip.txt"

if [[ -n "$patch_path" ]]; then
  [[ -r "$patch_path" ]] || fail "patch file not found or unreadable: $patch_path"
  cp "$patch_path" "$run_dir/diff.patch"
  # The b/ side names the file after the change; deleted files (+++ /dev/null) keep their a/ path.
  sed -n -E 's#^diff --git a/(.*) b/(.*)$#\2#p' "$run_dir/diff.patch" | sort -u > "$run_dir/files.txt"
else
  # Pin the patch format: the user's diff.noprefix / mnemonicPrefix / external / color config
  # would otherwise change the paths merge-findings.mjs parses out of it.
  git diff --no-ext-diff --no-color --src-prefix=a/ --dst-prefix=b/ "$base_ref...HEAD" > "$run_dir/diff.patch"
  git diff --name-only "$base_ref...HEAD" > "$run_dir/files.txt"
fi

[[ -s "$run_dir/diff.patch" && -s "$run_dir/files.txt" ]] || fail "empty diff — nothing to review (run dir: $run_dir)"

echo "$run_dir"
