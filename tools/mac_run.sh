#!/usr/bin/env bash
# Run a heavy 2bee.app command on the Mac Pro instead of jamesave.
#
# WHY: jamesave also carries the 2hives live streams and GPU renders, and above
# load 20 the streams lose their YouTube leg. On 2026-11-14 this lane's cargo
# test binary ran at ~1,800% CPU and three `tsc` runs at 120-180% each (load 40).
# Founder, via `home` (handover 2026-11-14-20-40-00): "ask 2bee.farm to move
# builds to macpro". The Mac Pro is approved for 100% use. Same pattern as the
# 2hives `app/tools/mac_test.sh`.
#
# Usage:
#   tools/mac_run.sh [--pull <lane-relative path>]... -- <command...>
#     e.g. tools/mac_run.sh -- cargo test -q --release
#          tools/mac_run.sh -- bash -c 'cd web && npx tsc -p tsconfig.browser.json --noEmit'
#          tools/mac_run.sh --pull web/src/wasm -- bash -c 'cargo build -p twobee-cam-wasm \
#              --target wasm32-unknown-unknown --release && wasm-bindgen --target web \
#              --out-dir web/src/wasm --no-typescript target/wasm32-unknown-unknown/release/twobee_cam_wasm.wasm'
#
# What it does:
#   1. rsyncs THIS WORKING TREE — uncommitted edits included, because that is what
#      a test of a change has to see — to macpro:~/mac-runs/2bee_app/, keeping the
#      repo layout so ../../hardware/... paths resolve. Mirrored: software/2bee.app
#      (target/ excluded: the Mac keeps its own, so builds are incremental there),
#      hardware/cad, hardware/pcb, hardware/bom, brand, and the one file legal/canon/facts.yaml.
#   2. runs <command> in the lane dir there, `nice -n 5`, with ~/.cargo/bin on PATH.
#      Steps 1-3 run under ONE local lock: one 2bee_app run at a time, and no sync
#      can rewrite the remote tree under a run that is still reading it.
#   3. pulls each --pull path back into this tree (e.g. the rebuilt WASM).
#
# Exit codes: the command's own · 2 bad invocation · 98 sync failed · 99 pull failed.
#   ⚠ 98/99 mean the command did NOT run / its output did NOT arrive — never a pass.
#
# Browsers: PLAYWRIGHT_BROWSERS_PATH defaults to ~/mac-runs/ms-playwright, THIS lane's Playwright build (chromium
#   1234, installed 2026-11-15 with `npx playwright install chromium`). The shared /fast/dev/ms-playwright is 2hives'
#   (build 1217) and every browser test launched against it failed "Executable doesn't exist" — 172 of 180.
# ⚠ What still runs on jamesave must be throttled: nice -n 19 ionice -c3 and
#   CARGO_BUILD_JOBS=4 (see this lane's CLAUDE.md, "Where heavy work runs").
set -uo pipefail

HOST=${MAC_RUN_HOST:-macpro}
LANE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(cd "$LANE/../.." && pwd)
REL=${LANE#"$REPO"/}
REMOTE=mac-runs/2bee_app

pulls=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --pull) [[ $# -ge 2 ]] || { echo "mac_run: --pull needs a path" >&2; exit 2; }; pulls+=("$2"); shift 2 ;;
    --) shift; break ;;
    *) echo "mac_run: unknown argument '$1' (usage: mac_run.sh [--pull path]... -- command...)" >&2; exit 2 ;;
  esac
done
[[ $# -gt 0 ]] || { echo "mac_run: no command given" >&2; exit 2; }

# 🔴 ONE LOCK AROUND SYNC + RUN + PULL (2026-11-14). The lock used to be taken on the Mac
# AFTER the rsync, and every run shares one remote tree. So a second mac_run rewrote the
# tree UNDER a running one: a 2 h full gate started at 21:01 read sources that three later
# test runs had replaced mid-pass, and its verdict described no single tree. Every caller
# runs from this host, so the lock is local and is held from before the sync until after
# the pull. (The remote flock below stays: harmless, and it guards a caller elsewhere.)
LOCK=${MAC_RUN_LOCK:-$HOME/.local/state/2bee_app-mac_run.lock}
mkdir -p "$(dirname "$LOCK")"
exec 8>"$LOCK"
if ! flock -n 8; then
  echo "mac_run: another 2bee_app mac_run holds $LOCK — waiting for it (its sync, run and pull)" >&2
  flock 8
fi

sync() {
  local src=$1
  [[ -d $REPO/$src ]] || return 0
  ssh -o BatchMode=yes "$HOST" "mkdir -p '$REMOTE/$src'" &&
    rsync -a --delete --exclude .git --exclude '/target/' "$REPO/$src/" "$HOST:$REMOTE/$src/"
}
for d in "$REL" hardware/cad hardware/pcb hardware/bom brand; do
  sync "$d" || { echo "mac_run: sync of $d to $HOST failed — the command was NOT run" >&2; exit 98; }
done
# ONE file outside those trees: the shop catalogue (the web dev server's prebuild) reads the entity-name aliases from
# legal/canon/facts.yaml. Without it the server never starts and the browser suite (gate I1) "errored" with no cause
# in the gate's 300-char tail — measured 2026-11-15. Only the file, not legal/canon.
ssh -o BatchMode=yes "$HOST" "mkdir -p '$REMOTE/legal/canon'" &&
  rsync -a "$REPO/legal/canon/facts.yaml" "$HOST:$REMOTE/legal/canon/facts.yaml" ||
  { echo "mac_run: sync of legal/canon/facts.yaml to $HOST failed — the command was NOT run" >&2; exit 98; }
# A GIT INDEX, NO HISTORY (2026-11-15). The tree has no .git, so every `git ls-files` in a run failed with "not a
# git repository": the shop catalogue (the browser suite's web server) and the gate limbs that compare a walk with the
# tracked set. The tracked list of the synced paths (`git ls-files -s`) is loaded into a fresh index there; no object
# and no history is copied, so `ls-files` answers and anything that needs a blob (cat-file, archive, diff) still fails
# loudly, as it should. Rebuilt on every run, so it is THIS tree's tracked set.
git -C "$REPO" ls-files -s -z -- "$REL" hardware/cad hardware/pcb hardware/bom brand legal/canon/facts.yaml |
  ssh -o BatchMode=yes "$HOST" "cd '$REMOTE' && { [ -d .git ] || git init -q; } && rm -f .git/index && git update-index -z --index-info" ||
  { echo "mac_run: the git index on $HOST could not be built — the command was NOT run" >&2; exit 98; }

# The command travels as one argv string, quoted for the remote shell.
cmd=$(printf '%q ' "$@")
ssh -o BatchMode=yes "$HOST" "cd '$REMOTE/$REL' && export PATH=\$HOME/.cargo/bin:\$PATH CARGO_BUILD_JOBS=\${CARGO_BUILD_JOBS:-11} RUST_TEST_THREADS=\${RUST_TEST_THREADS:-11} PLAYWRIGHT_BROWSERS_PATH=\${PLAYWRIGHT_BROWSERS_PATH:-\$HOME/mac-runs/ms-playwright} && \
  exec 9>\$HOME/mac-runs/2bee_app.lock && flock 9 && \
  echo \">> mac_run: \$(hostname) load \$(cut -d' ' -f1-3 /proc/loadavg)\" >&2 && nice -n 5 $cmd"
rc=$?

for p in "${pulls[@]}"; do
  rsync -a --delete "$HOST:$REMOTE/$REL/$p/" "$LANE/$p/" || { echo "mac_run: pull of $p failed (command rc $rc)" >&2; exit 99; }
done
exit $rc
