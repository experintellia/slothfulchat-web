#!/usr/bin/env bash
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
script=$here/deploy-preview.sh
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT

# Exercise the actual generator functions without running the forced-command gate.
# shellcheck disable=SC1090,SC1091
source "$script"
WEBXDC_FALLBACK=$here/../../../packages/web-app/static/webxdc-test.html
die() { printf '%s\n' "$*" >&2; exit 1; }

write_webxdc_site 287 "$work/pr-287/dist" "$work/287.caddy"
write_webxdc_site 308 "$work/pr-308/dist" "$work/308.caddy"
write_webxdc_site next "$work/next/dist" "$work/next.caddy"
grep -Fq '*.webxdc.pr-287.lollolollol.lol {' "$work/287.caddy"
grep -Fq 'frame-ancestors https://pr-287.lollolollol.lol' "$work/287.caddy"
grep -Fq "$work/pr-287/dist" "$work/287.caddy"
grep -Fq '*.webxdc.pr-308.lollolollol.lol {' "$work/308.caddy"
if grep -Fq 'pr-287' "$work/308.caddy"; then
	exit 1
fi
grep -Fq '*.webxdc.next.lollolollol.lol {' "$work/next.caddy"

mkdir -p "$work/input/dist/caddy"
printf 'main\n' >"$work/input/dist/index.html"
printf 'routes\n' >"$work/input/dist/caddy/routes.caddy"
tar -czf "$work/old.tgz" -C "$work/input" dist
receive_dist "$work/old" <"$work/old.tgz"
cmp "$WEBXDC_FALLBACK" "$work/old/dist/webxdc-test.html"
printf 'branch version\n' >"$work/input/dist/webxdc-test.html"
tar -czf "$work/new.tgz" -C "$work/input" dist
receive_dist "$work/new" <"$work/new.tgz"
grep -Fxq 'branch version' "$work/new/dist/webxdc-test.html"

mkdir -p "$work/backup-dir"
printf 'old route\n' >"$work/backup-route"
printf 'old site\n' >"$work/backup-site"
printf 'bad route\n' >"$work/route"
printf 'bad site\n' >"$work/site"
restore_slot "$work/dir" "$work/route" "$work/site" "$work/backup-dir" "$work/backup-route" "$work/backup-site"
test -d "$work/dir"
grep -Fxq 'old route' "$work/route"
grep -Fxq 'old site' "$work/site"

ROOT=$work/server
PREVIEWS=$ROOT/previews
ROUTES=$ROOT/routes
WEBXDC_SITES=$ROOT/webxdc-sites
ROLLBACK=$ROOT/.rollback
mkdir -p "$PREVIEWS/pr-287/dist" "$ROUTES" "$WEBXDC_SITES" "$ROLLBACK"
printf 'old app\n' >"$PREVIEWS/pr-287/dist/index.html"
printf 'old route\n' >"$ROUTES/pr-287.caddy"
printf 'old site\n' >"$WEBXDC_SITES/pr-287.caddy"
validate_config() { [ "${FAIL_VALIDATE:-0}" != 1 ]; }
reload_caddy() { :; }
mv() {
	if [ "${FAIL_BACKUP:-0}" = 1 ] && [ "$2" = "$WEBXDC_SITES/pr-287.caddy" ] && [ "$3" = "$ROLLBACK/webxdc-pr-287.caddy" ]; then
		return 1
	fi
	if [ "${FAIL_SITE:-0}" = 1 ] && [ "$2" = "$ROOT/.incoming-webxdc-pr-287.caddy" ] && [ "$3" = "$WEBXDC_SITES/pr-287.caddy" ]; then
		return 1
	fi
	command mv "$@"
}
for failure in FAIL_BACKUP FAIL_SITE FAIL_VALIDATE; do
	if (export "$failure=1"; do_upload 287 <"$work/new.tgz"); then
		printf 'upload accepted %s\n' "$failure" >&2
		exit 1
	fi
	grep -Fxq 'old app' "$PREVIEWS/pr-287/dist/index.html"
	grep -Fxq 'old route' "$ROUTES/pr-287.caddy"
	grep -Fxq 'old site' "$WEBXDC_SITES/pr-287.caddy"
done
do_upload 287 <"$work/new.tgz"
grep -Fxq 'main' "$PREVIEWS/pr-287/dist/index.html"
grep -Fq '*.webxdc.pr-287.lollolollol.lol' "$WEBXDC_SITES/pr-287.caddy"
if (export FAIL_VALIDATE=1; do_delete 287); then
	printf 'delete accepted failed validation\n' >&2
	exit 1
fi
test -f "$PREVIEWS/pr-287/dist/index.html"
test -f "$ROUTES/pr-287.caddy"
test -f "$WEBXDC_SITES/pr-287.caddy"
do_delete 287
test ! -e "$WEBXDC_SITES/pr-287.caddy"
printf 'route generation, fallback, swap rollback, and deletion passed\n'
