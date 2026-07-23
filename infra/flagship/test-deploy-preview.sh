#!/usr/bin/env bash
# Self-test for deploy-preview.sh. Stubs sudo/systemctl (the reload half) but
# runs a REAL `caddy validate` against a flagship-shaped config with the
# `previews/*/site.caddy` glob in play — a stubbed validate can't see glob
# collisions, which once let a regression through where the rollback backup's
# stale site.caddy made every update of a deployed PR slot fail validate.
# Run:  bash infra/flagship/test-deploy-preview.sh   (needs caddy in PATH)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
command -v caddy >/dev/null || { echo "SKIP-FAIL: needs a caddy binary in PATH"; exit 1; }

G=$(mktemp -d)
trap 'rm -rf "$G"' EXIT
mkdir -p "$G/bin" "$G/srv/previews" "$G/work/dist/caddy"

# sudo stub: swallow `sudo systemctl reload caddy`, log the call.
printf '#!/bin/bash\necho "sudo $*" >>"%s/calls"\n' "$G" >"$G/bin/sudo"
chmod +x "$G/bin/sudo"

# Flagship-shaped config: the real previews glob, real routes.caddy in bundles.
cat >"$G/Caddyfile" <<EOF
{
	auto_https off
}
(wildcard_tls) {
	# no certs in the self-test
}
# NEXT_IMPORT import $G/srv/next/dist/caddy/routes.caddy next.slothful.chat $G/srv/next/dist
import $G/srv/previews/*/site.caddy
EOF

cp "$here/../../packages/web-app/caddy/routes.caddy" "$G/work/dist/caddy/routes.caddy"
echo v1 >"$G/work/dist/marker-v1" && tar -C "$G/work" -czf "$G/v1.tgz" dist
rm "$G/work/dist/marker-v1"
echo v2 >"$G/work/dist/marker-v2" && tar -C "$G/work" -czf "$G/v2.tgz" dist
cp "$G/work/dist/caddy/routes.caddy" "$G/routes.ok"
echo 'this is not a caddyfile {{{' >"$G/work/dist/caddy/routes.caddy"
tar -C "$G/work" -czf "$G/broken.tgz" dist
cp "$G/routes.ok" "$G/work/dist/caddy/routes.caddy"
ln -s /etc/passwd "$G/work/dist/evil" && tar -C "$G/work" -czf "$G/evil.tgz" dist && rm "$G/work/dist/evil"

run() {
	SSH_ORIGINAL_COMMAND=$1 SLOTHFUL_DEPLOY_ROOT=$G/srv SLOTHFUL_DEPLOY_CADDYFILE=$G/Caddyfile \
		PATH="$G/bin:$PATH" bash "$here/deploy-preview.sh"
}
ok() { echo "ok: $*"; }

# 1. fresh PR upload
run 'upload 5' <"$G/v1.tgz"
[ -f "$G/srv/previews/pr-5/dist/marker-v1" ]
grep -q 'pr-5\.preview\.slothful\.chat' "$G/srv/previews/pr-5/site.caddy"
ok "fresh upload 5"

# 2. UPDATE of a deployed slot — the glob-collision regression case: must pass
#    real validate even though the old slot is parked for rollback mid-swap.
run 'upload 5' <"$G/v2.tgz"
[ -f "$G/srv/previews/pr-5/dist/marker-v2" ]
[ ! -e "$G/srv/.rollback/pr-5" ]
ok "update deployed slot (real validate, glob in play)"

# 3. broken update -> real validate fails -> previous slot restored, merged
#    config still loadable
run 'upload 5' <"$G/broken.tgz" && { echo "FAIL: broken update passed"; exit 1; }
[ -f "$G/srv/previews/pr-5/dist/marker-v2" ]
grep -q 'pr-5\.preview\.slothful\.chat' "$G/srv/previews/pr-5/site.caddy"
caddy validate --config "$G/Caddyfile" --adapter caddyfile >/dev/null 2>&1
ok "broken update rolled back, on-disk config loadable"

# 4. good update right after a rollback
run 'upload 5' <"$G/v1.tgz"
[ -f "$G/srv/previews/pr-5/dist/marker-v1" ]
ok "update after rollback"

# 5. symlink reject, slot untouched
run 'upload 5' <"$G/evil.tgz" && { echo "FAIL: symlink accepted"; exit 1; }
[ -f "$G/srv/previews/pr-5/dist/marker-v1" ]
ok "symlink rejected"

# 6. next: fresh deploy while the static import is still commented (matches
#    real bring-up), then activate it (the README step), update, break it —
#    with the import active, a broken bundle must roll back or the on-disk
#    config would fail the next caddy restart.
run 'upload next' <"$G/v1.tgz"
sed -i 's/^# NEXT_IMPORT //' "$G/Caddyfile"
caddy validate --config "$G/Caddyfile" --adapter caddyfile >/dev/null 2>&1
run 'upload next' <"$G/v2.tgz"
run 'upload next' <"$G/broken.tgz" && { echo "FAIL: broken next passed"; exit 1; }
[ -f "$G/srv/next/dist/marker-v2" ] && [ ! -e "$G/srv/next/site.caddy" ]
caddy validate --config "$G/Caddyfile" --adapter caddyfile >/dev/null 2>&1
ok "next fresh/activate-import/update/rollback"

# 7. delete: deployed -> gone + config loadable; undeployed -> no-op, no reload
run 'delete 5'
[ ! -e "$G/srv/previews/pr-5" ]
caddy validate --config "$G/Caddyfile" --adapter caddyfile >/dev/null 2>&1
cp "$G/calls" "$G/calls.before"
run 'delete 99' | :
cmp -s "$G/calls" "$G/calls.before"
ok "delete deployed + no-op undeployed"

# 8. list shows slots only
run 'upload 7' <"$G/v1.tgz" >/dev/null 2>&1
mkdir -p "$G/srv/previews/_keep"
[ "$(run list)" = "pr-7" ]
ok "list"

echo "ALL PASS"
