#!/usr/bin/env bash
# run-skill-integration.sh — install changed skills on a live SLICC leader and self-test with tst.
#
# Usage (inside the leader's virtual shell — just-bash, no trap/pipefail):
#   bash /mnt/repo/tools/run-skill-integration.sh /tmp/skill-integration-targets.tsv
#
# Record columns (pipe-separated): name, action (tst|skip), reason, comma-separated tst paths, skipped-test count.
# Writes /workspace/skill-integration/{report.md,status,*.tap} and exits 0 only when
# the canary passed, every skill installed, every skill has a tst suite, and every tst suite passed.

set -eu

TARGETS=${1:-/tmp/skill-integration-targets.tsv}
REPO=${REPO_MOUNT:-/mnt/repo}
SKILLS_ROOT=/workspace/skills
REPORT_DIR=/workspace/skill-integration

failed=0
canary_rc=1

mkdir -p "$REPORT_DIR"
: >"$REPORT_DIR/rows.md"
: >"$REPORT_DIR/details.md"
echo fail >"$REPORT_DIR/status"

die_env() {
  printf '%s\n' "$*" >&2
  printf '\n### Environment\n\n```\n%s\n```\n' "$*" >>"$REPORT_DIR/details.md"
  failed=1
}

append_row() {
  printf '| `%s` | %s | %s | %s |\n' "$1" "$2" "$3" "$4" >>"$REPORT_DIR/rows.md"
}

write_report() {
  {
    echo '## Skill integration'
    echo
    echo 'Live SLICC leader. Each affected skill is copied to `/workspace/skills/<name>` and self-tested with the bundled `tst` runner.'
    echo
    echo '| Skill | Install | Self-test | Status |'
    echo '| --- | --- | --- | --- |'
    if [ -s "$REPORT_DIR/rows.md" ]; then
      cat "$REPORT_DIR/rows.md"
    else
      echo '| — | — | canary only | |'
    fi
    echo
    if [ -s "$REPORT_DIR/details.md" ]; then
      cat "$REPORT_DIR/details.md"
    fi
    echo
    if [ "$failed" -eq 0 ]; then
      echo '**Result: pass.**'
    else
      echo '**Result: fail.**'
    fi
  } >"$REPORT_DIR/report.md"
  if [ "$failed" -eq 0 ]; then
    echo pass >"$REPORT_DIR/status"
  else
    echo fail >"$REPORT_DIR/status"
  fi
}

finish() {
  write_report
  if [ "$failed" -ne 0 ]; then
    echo 'SKILL_INTEGRATION_STATUS=fail'
    exit 1
  fi
  echo 'SKILL_INTEGRATION_STATUS=pass'
  exit 0
}

if [ ! -d "$REPO/skills" ]; then
  die_env "repo mount missing: $REPO/skills (expected the PR checkout at $REPO)"
  finish
fi

echo '::group::ipk add -g typescript@6.0.3'
if ! ipk add -g typescript@6.0.3; then
  echo '::endgroup::'
  die_env 'ipk add -g typescript@6.0.3 failed (tst will not run without TypeScript 6)'
  finish
fi
ipk list -g || true
echo '::endgroup::'

run_canary() {
  mkdir -p /tmp/tst-canary
  cat >/tmp/tst-canary/canary.test.js <<'EOF'
import test, { is } from 'tst';
test('tst runner is alive', () => {
  is(1 + 1, 2);
});
EOF
  echo '::group::tst canary'
  canary_rc=0
  cd /tmp/tst-canary
  tst --reporter=tap > /tmp/tst-canary/canary.tap 2>&1 || canary_rc=$?
  cd "$REPO"
  cat /tmp/tst-canary/canary.tap
  cp /tmp/tst-canary/canary.tap "$REPORT_DIR/canary.tap"
  echo '::endgroup::'
  if [ "$canary_rc" -ne 0 ]; then
    echo "::error title=tst canary::canary exited $canary_rc — the live instance cannot run tst"
    {
      echo
      echo '### Canary'
      echo
      echo "\`tst\` canary exited $canary_rc. Skill suites were not started."
      echo
      echo '```'
      cat /tmp/tst-canary/canary.tap
      echo '```'
    } >>"$REPORT_DIR/details.md"
    failed=1
    return 1
  fi
  {
    echo
    echo '### Canary'
    echo
    echo 'The bundled `tst` runner executed a one-assertion suite and exited 0.'
  } >>"$REPORT_DIR/details.md"
  return 0
}

run_canary || true

install_skill() {
  name=$1
  src="$REPO/skills/$name"
  dst="$SKILLS_ROOT/$name"
  if [ ! -f "$src/SKILL.md" ]; then
    echo "::error file=skills/$name/SKILL.md,title=$name install::source SKILL.md missing on the repo mount"
    return 1
  fi
  mkdir -p "$SKILLS_ROOT"
  rm -rf "$dst"
  cp -R "$src" "$dst"
  if [ ! -f "$dst/SKILL.md" ]; then
    echo "::error file=skills/$name/SKILL.md,title=$name install::copy did not produce /workspace/skills/$name/SKILL.md"
    return 1
  fi
  echo "installed $name -> $dst"
  return 0
}

# just-bash has no arrays: rebuild $@ from a comma-separated list.
run_tst() {
  name=$1
  tests_csv=$2
  dst="$SKILLS_ROOT/$name"
  tap="$REPORT_DIR/$name.tap"
  set --
  old_ifs=$IFS
  IFS=,
  for rel in $tests_csv; do
    IFS=$old_ifs
    # just-bash has no [!class] negation; reject injection-prone bytes only.
    # The host detector already allowlists [A-Za-z0-9._/-] without '..'.
    case "$rel" in
      '') continue ;;
      *..* | /* | */ | *' '* | *'|'* | *';'* | *'$'* | *$'\t'* | *$'\n'*)
        echo "::error title=$name tst::refusing test path $rel"
        return 1
        ;;
    esac
    set -- "$@" "$rel"
  done
  IFS=$old_ifs
  if [ "$#" -eq 0 ]; then
    echo "::error title=$name tst::action=tst but no test paths"
    return 1
  fi
  echo "::group::tst $name $*"
  rc=0
  cd "$dst"
  tst --reporter=tap "$@" >"$tap" 2>&1 || rc=$?
  cd "$REPO"
  cat "$tap"
  echo '::endgroup::'
  if [ "$rc" -ne 0 ]; then
    echo "::error file=skills/$name/SKILL.md,title=$name tst failed::tst exited $rc"
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        'not ok '*) echo "::error file=skills/$name/SKILL.md,title=$name::$line" ;;
      esac
    done <"$tap"
  fi
  return "$rc"
}

if [ ! -f "$TARGETS" ]; then
  echo "no targets file at $TARGETS — canary only"
  TARGETS=/dev/null
fi

while IFS='|' read -r name action reason tst_tests skip_count || [ -n "${name:-}" ]; do
  case "$name" in
    '' | '#'*) continue ;;
  esac
  # just-bash has no [!class] negation — `*[!a-z0-9-]*` treated '!' as a literal
  # and refused every skill name (da-live, github, search). Reject path-injection
  # bytes only; the host detector already allowlists [a-z0-9][a-z0-9-]*.
  case "$name" in
    '' | -* | *'|'* | *'/'* | *'..'* | *' '* | *'.'* | *$'\t'* | *$'\n'*)
      echo "::error title=skill integration::refusing unsafe skill name $name"
      append_row "$name" '—' 'refused' 'fail'
      failed=1
      continue
      ;;
  esac

  echo "::group::install $name"
  if ! install_skill "$name"; then
    echo '::endgroup::'
    append_row "$name" '✗' '—' 'fail'
    {
      echo
      printf '### `%s`\n\n' "$name"
      printf 'Install failed. Source: `%s/skills/%s`.\n' "$REPO" "$name"
    } >>"$REPORT_DIR/details.md"
    failed=1
    continue
  fi
  echo '::endgroup::'

  skip_count=${skip_count:-0}
  reason=${reason:-}

  if [ "$action" = 'tst' ]; then
    if [ "$canary_rc" -ne 0 ]; then
      append_row "$name" '✓' 'tst skipped (canary failed)' 'fail'
      failed=1
      continue
    fi
    if run_tst "$name" "$tst_tests"; then
      selftest="tst · ${tst_tests}"
      if [ "$skip_count" -gt 0 ]; then
        selftest="$selftest · skipped $skip_count"
      fi
      append_row "$name" '✓' "$selftest" 'pass'
      {
        echo
        printf '### `%s`\n\n' "$name"
        printf 'Installed to `/workspace/skills/%s`. `tst` exited 0.\n\n' "$name"
        echo '```'
        cat "$REPORT_DIR/$name.tap"
        echo '```'
      } >>"$REPORT_DIR/details.md"
    else
      append_row "$name" '✓' "tst · exit ≠ 0" 'fail'
      {
        echo
        printf '### `%s`\n\n' "$name"
        printf 'Installed to `/workspace/skills/%s`. `tst` failed.\n\n' "$name"
        echo '```'
        cat "$REPORT_DIR/$name.tap"
        echo '```'
      } >>"$REPORT_DIR/details.md"
      failed=1
    fi
    continue
  fi

  case "$reason" in
    node:test)
      selftest="no tst suite · $skip_count node:test file(s) do not run in SLICC (#389)"
      echo "::error file=skills/$name/SKILL.md,title=$name::No in-SLICC tst suite. $skip_count file(s) import node:test, which cannot load here. Add a *.test.js that imports tst."
      ;;
    none)
      selftest='no tst suite'
      echo "::error file=skills/$name/SKILL.md,title=$name::No in-SLICC tst suite. Add a *.test.js that imports tst (see CLAUDE.md §16)."
      ;;
    unknown)
      selftest="no tst suite · $skip_count test file(s) do not import tst"
      echo "::error file=skills/$name/SKILL.md,title=$name::No in-SLICC tst suite. Test files must import tst."
      ;;
    *)
      selftest="no tst suite · ${reason:-none}"
      echo "::error file=skills/$name/SKILL.md,title=$name::No in-SLICC tst suite ($reason)."
      ;;
  esac
  append_row "$name" '✓' "$selftest" 'fail'
  {
    echo
    printf '### `%s`\n\n' "$name"
    printf 'Installed to `/workspace/skills/%s`. %s.\n' "$name" "$selftest"
  } >>"$REPORT_DIR/details.md"
  failed=1
done <"$TARGETS"

finish
