#!/usr/bin/env bash
# Self-test for deploy-preview.sh. Stubs sudo/systemctl (the reload half) but
# runs a REAL `caddy validate` against a flagship-shaped config with the
# `previews/*/site.caddy` glob in play — a stubbed validate can't see glob
# collisions, which once let a regression through where the rollback backup's
# stale site.caddy made every update of a deployed PR slot fail validate.
#
# Cases 1-8 are the deploy/rollback/glob mechanics. Cases 9-11 are the trust
# boundary: real caddy against hostile routes.caddy bundles (each fixture is
# asserted to adapt cleanly first, so a rejection can only be the allowlist's
# doing), the archive limits, and a final proof the happy path still works.
# Cases 12-13 are the deploy transaction: a config that loads but does not
# serve must roll back (curl is stubbed — nothing is listening here), and a
# second deploy must not run while one holds the server lock.
#
# Run:  bash infra/flagship/test-deploy-preview.sh   (needs caddy in PATH; the
# wildcard site address needs caddy >= 2.7, so a distro 2.6 in /usr/bin will
# fail here — put the real binary earlier in PATH)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
command -v caddy >/dev/null || { echo "SKIP-FAIL: needs a caddy binary in PATH"; exit 1; }

G=$(mktemp -d)
trap 'rm -rf "$G"' EXIT
mkdir -p "$G/bin" "$G/srv/previews" "$G/work/dist/caddy"

# sudo stub: swallow `sudo systemctl reload caddy`, log the call.
printf '#!/bin/bash\necho "sudo $*" >>"%s/calls"\n' "$G" >"$G/bin/sudo"
chmod +x "$G/bin/sudo"

# curl stub: no caddy is actually serving here, so the health check's probes are
# logged (so the tests can assert WHICH hosts were probed) and answered "up" —
# unless $G/curl-fail exists, which is how case 12 plays a deploy that loads
# fine and serves nothing.
printf '#!/bin/bash\necho "$*" >>"%s/curl-calls"\n[ -e "%s/curl-fail" ] && exit 22\nexit 0\n' \
	"$G" "$G" >"$G/bin/curl"
chmod +x "$G/bin/curl"

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
		SLOTHFUL_DEPLOY_HEALTH_TIMEOUT=1 \
		PATH="$G/bin:$PATH" bash "$here/deploy-preview.sh"
}
ok() { echo "ok: $*"; }

# 1. fresh PR upload. Both site addresses the bundle claims must be probed
#    before the deploy is called done — including the *.webxdc. wildcard, at a
#    concrete label under it, since that is what exercises the wildcard cert.
run 'upload 5' <"$G/v1.tgz"
[ -f "$G/srv/previews/pr-5/dist/marker-v1" ]
grep -q 'pr-5\.preview\.slothful\.chat' "$G/srv/previews/pr-5/site.caddy"
grep -q 'https://pr-5\.preview\.slothful\.chat/' "$G/curl-calls"
grep -q 'https://deploy-health\.webxdc\.pr-5\.preview\.slothful\.chat/' "$G/curl-calls"
ok "fresh upload 5, both hosts health-checked"

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

# --- from here on the deployed slot is pr-7 (marker-v1), and every case must
#     leave it exactly like that: a rejected upload never disturbs what serves.
slot=$G/srv/previews/pr-7
intact() {
	[ -f "$slot/dist/marker-v1" ] || { echo "FAIL: slot damaged ($1)"; exit 1; }
	grep -q 'pr-7\.preview\.slothful\.chat' "$slot/site.caddy" || { echo "FAIL: site.caddy lost ($1)"; exit 1; }
}

# 9. hostile routes.caddy. Each fixture is config `caddy validate` and `caddy
#    adapt` both accept with exit 0 — that is asserted below, so a rejection
#    can only come from the allowlist over the adapted JSON, never from a typo
#    that made the fixture unparseable.
hostile() {
	local what=$1 body=$2
	printf '%s\n' "$body" >"$G/hostile-routes.caddy"
	printf '(wildcard_tls) {\n}\nimport %s pr-7.preview.slothful.chat %s/dist\n' \
		"$G/hostile-routes.caddy" "$slot" >"$G/hostile-wrapper.caddy"
	caddy adapt --config "$G/hostile-wrapper.caddy" --adapter caddyfile >/dev/null 2>&1 \
		|| { echo "FAIL: fixture does not even adapt, so it proves nothing ($what)"; exit 1; }
	cp "$G/hostile-routes.caddy" "$G/work/dist/caddy/routes.caddy"
	tar -C "$G/work" -czf "$G/hostile.tgz" dist
	cp "$G/routes.ok" "$G/work/dist/caddy/routes.caddy"
	run 'upload 7' <"$G/hostile.tgz" && { echo "FAIL: accepted hostile routes.caddy ($what)"; exit 1; }
	intact "$what"
	ok "hostile rejected: $what"
}
# Each fixture isolates ONE check: everything else about it is legitimate, so
# the named check is provably the one that fired.
hostile 'reverse_proxy to the caddy admin API' '{args[0]} {
	root * {args[1]}
	reverse_proxy localhost:2019
}'
hostile '{env.*} placeholder (DNS API credential)' '{args[0]} {
	root * {args[1]}
	rewrite * /{env.PORKBUN_API_KEY}
	file_server
}'
hostile 'root outside the slot' '{args[0]} {
	root * /etc
	file_server
}'
hostile 'root escaping the slot via ..' '{args[0]} {
	root * {args[1]}/../../..
	file_server
}'
hostile 'file_server browse' '{args[0]} {
	root * {args[1]}
	file_server browse
}'
hostile 'a hostname the slot does not own' '{args[0]} {
	root * {args[1]}
	file_server
}
web.slothful.chat {
	root * {args[1]}
	file_server
}'
# A header is NOT confined to the host that sends it: a cookie scoped to the
# parent domain lands on next, prod and every sibling slot. Allowing the
# `headers` handler is why the header NAMES are allowlisted too.
hostile 'a cookie scoped to the parent domain' '{args[0]} {
	root * {args[1]}
	header Set-Cookie "session=attacker; Domain=slothful.chat; Path=/"
	file_server
}'
hostile 'unpicking its own frame-ancestors' '{args[0]} {
	root * {args[1]}
	header -Content-Security-Policy
	file_server
}'

# 10. archive limits — all enforced BEFORE extraction, so nothing large ever
#     lands. Limits are read out of the script itself so these fixtures cannot
#     drift out of sync with it.
eval "$(grep -E '^(MAX_TGZ_BYTES|MAX_ENTRIES|MAX_ENTRY_BYTES)=' "$here/deploy-preview.sh")"

# oversized compressed stream: never even reaches tar.
head -c $((MAX_TGZ_BYTES + 1)) /dev/zero | run 'upload 7' \
	&& { echo "FAIL: oversized stream accepted"; exit 1; }
intact "oversized stream"
ok "oversized compressed stream rejected"

# too many members.
mkdir -p "$G/many/dist/caddy"
cp "$G/routes.ok" "$G/many/dist/caddy/routes.caddy"
(cd "$G/many/dist" && seq $((MAX_ENTRIES + 1)) | xargs touch)
tar -C "$G/many" -czf "$G/many.tgz" dist
run 'upload 7' <"$G/many.tgz" && { echo "FAIL: over-count archive accepted"; exit 1; }
intact "over-count archive"
ok "over-count archive rejected"

# sparse bomb: a few hundred bytes on the wire declaring a member far larger
# than the disk. Only the DECLARED size in the member header exposes this.
mkdir -p "$G/sparse/dist/caddy"
cp "$G/routes.ok" "$G/sparse/dist/caddy/routes.caddy"
truncate -s $((MAX_ENTRY_BYTES * 64)) "$G/sparse/dist/huge.bin"
tar -C "$G/sparse" --sparse -czf "$G/sparse.tgz" dist
[ "$(stat -c %s "$G/sparse.tgz")" -lt 100000 ] || { echo "FAIL: sparse fixture is not tiny"; exit 1; }
run 'upload 7' <"$G/sparse.tgz" && { echo "FAIL: sparse bomb accepted"; exit 1; }
intact "sparse bomb"
# Scratch is a unique mktemp path per run now, so the check is "nothing named
# .incoming-* survives", not one fixed name.
[ -z "$(find "$G/srv" -maxdepth 2 -name '.incoming-*' -print -quit)" ] \
	|| { echo "FAIL: scratch left behind"; exit 1; }
ok "sparse bomb rejected, scratch cleaned up"

# 11. the real bundle still deploys after all that — the allowlist must not
#     have quietly broken the happy path.
run 'upload 7' <"$G/v2.tgz"
[ -f "$slot/dist/marker-v2" ]
ok "real bundle still accepted"

# 12. a deploy that VALIDATES and RELOADS but does not serve. This is the case
#     validate alone always called a success: config loads, site is dead. The
#     rollback copy must still exist at that point, and caddy must be reloaded
#     again after the restore — the dead bundle is already the loaded config,
#     so putting the directory back is only half the job.
run 'upload 7' <"$G/v1.tgz"   # back to a known marker so intact() applies
before=$(wc -l <"$G/calls")
touch "$G/curl-fail"
run 'upload 7' <"$G/v2.tgz" && { echo "FAIL: dead deploy reported healthy"; exit 1; }
intact "dead deploy"
[ ! -e "$G/srv/.rollback/pr-7" ] || { echo "FAIL: rollback copy left behind"; exit 1; }
[ "$(($(wc -l <"$G/calls") - before))" -eq 2 ] \
	|| { echo "FAIL: expected a reload for the deploy and one after the rollback"; exit 1; }
caddy validate --config "$G/Caddyfile" --adapter caddyfile >/dev/null 2>&1

# same, with no previous deployment: the fresh slot must be removed entirely
# rather than left serving nothing.
run 'upload 8' <"$G/v2.tgz" && { echo "FAIL: dead fresh deploy reported healthy"; exit 1; }
[ ! -e "$G/srv/previews/pr-8" ] || { echo "FAIL: dead fresh slot left behind"; exit 1; }
caddy validate --config "$G/Caddyfile" --adapter caddyfile >/dev/null 2>&1
rm "$G/curl-fail"
ok "dead deploy rolled back (update + fresh slot)"

# 13. the server lock. Everything above is per-slot logic; this is the part
#     that stops two PRs from racing the shared validate/reload. Hold the lock
#     from outside and a deploy must refuse rather than proceed — then succeed
#     once it is free. (LOCK_WAIT is dialled down so the give-up path is a
#     second, not the production quarter-hour.)
flock "$G/srv/.deploy.lock" -c 'sleep 4' &
holder=$!
sleep 0.5
SLOTHFUL_DEPLOY_LOCK_WAIT=1 run 'upload 7' <"$G/v2.tgz" 2>"$G/lock.err" \
	&& { echo "FAIL: deploy ran while the lock was held"; exit 1; }
grep -q 'server lock' "$G/lock.err" || { echo "FAIL: blocked for some other reason"; cat "$G/lock.err"; exit 1; }
intact "lock held"
wait "$holder"
run 'upload 7' <"$G/v2.tgz"
[ -f "$slot/dist/marker-v2" ]
ok "server lock serialises deploys"

echo "ALL PASS"
