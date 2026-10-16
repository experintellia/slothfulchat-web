#!/usr/bin/env bash
# Forced-command gate for the lollolollol.lol next and PR preview server.
set -euo pipefail
umask 022
PATH=/usr/local/bin:/usr/bin:/bin
export PATH

ROOT=/srv/slothfulchat
PREVIEWS=$ROOT/previews
ROUTES=$ROOT/routes
WEBXDC_SITES=$ROOT/webxdc-sites
WEBXDC_FALLBACK=$ROOT/shared/webxdc-test.html
ROLLBACK=$ROOT/.rollback
SYSTEMCTL=/usr/bin/systemctl
CADDY_USER=caddy
CADDY_VALIDATE=/usr/local/libexec/slothful-caddy-validate
BASE_DOMAIN=lollolollol.lol
MAX_UPLOAD_BYTES=268435456

log() { printf 'slothful-deploy: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }
validate_config() { sudo -u "$CADDY_USER" "$CADDY_VALIDATE"; }
reload_caddy() { sudo "$SYSTEMCTL" reload caddy; }

restore_backups() {
	local dir=$1 route=$2 webxdc_site=$3 backup_dir=$4 backup_route=$5 backup_webxdc=$6
	if [ -e "$backup_dir" ]; then mv -- "$backup_dir" "$dir" || die "cannot restore $dir"; fi
	if [ -e "$backup_route" ]; then mv -- "$backup_route" "$route" || die "cannot restore $route"; fi
	if [ -e "$backup_webxdc" ]; then mv -- "$backup_webxdc" "$webxdc_site" || die "cannot restore $webxdc_site"; fi
}

backup_slot() {
	local dir=$1 route=$2 webxdc_site=$3 backup_dir=$4 backup_route=$5 backup_webxdc=$6
	if [ -e "$dir" ] && ! mv -- "$dir" "$backup_dir"; then
		return 1
	fi
	if [ -e "$route" ] && ! mv -- "$route" "$backup_route"; then
		restore_backups "$dir" "$route" "$webxdc_site" "$backup_dir" "$backup_route" "$backup_webxdc"
		return 1
	fi
	if [ -e "$webxdc_site" ] && ! mv -- "$webxdc_site" "$backup_webxdc"; then
		restore_backups "$dir" "$route" "$webxdc_site" "$backup_dir" "$backup_route" "$backup_webxdc"
		return 1
	fi
}

restore_slot() {
	local dir=$1 route=$2 webxdc_site=$3 backup_dir=$4 backup_route=$5 backup_webxdc=$6
	rm -rf -- "$dir" || die "cannot remove failed slot $dir"
	rm -f -- "$route" "$webxdc_site" || die "cannot remove failed routes"
	restore_backups "$dir" "$route" "$webxdc_site" "$backup_dir" "$backup_route" "$backup_webxdc"
}

write_route() {
	local target=$1 dist_root=$2 destination=$3
	local app_host route_id webxdc_prefix max_slug domain_regex
	if [ "$target" = next ]; then
		app_host=next.$BASE_DOMAIN
		route_id=next
		webxdc_prefix=webxdc-next-
	else
		app_host=pr-$target.$BASE_DOMAIN
		route_id=pr_$target
		webxdc_prefix=webxdc-pr-$target-
	fi
	max_slug=$((63 - ${#webxdc_prefix}))
	(( max_slug > 0 )) || die "webxdc hostname prefix exceeds DNS label limit"
	domain_regex=${BASE_DOMAIN//./\\.}
	# Keep the old flat route working while existing links are in circulation.
	cat >"$destination" <<EOF
@${route_id}_app host ${app_host}
handle @${route_id}_app {
	root * ${dist_root}
	error /caddy/* 404
	encode zstd gzip
	file_server
}

@${route_id}_webxdc header_regexp Host ^${webxdc_prefix}[a-z0-9]{1,${max_slug}}\.${domain_regex}(?::443)?\$
handle @${route_id}_webxdc {
	root * ${dist_root}
	encode zstd gzip
	rewrite * /webxdc-test.html
	file_server
}
EOF
}

write_webxdc_site() {
	local target=$1 dist_root=$2 destination=$3 app_host
	if [ "$target" = next ]; then
		app_host=next.$BASE_DOMAIN
	else
		app_host=pr-$target.$BASE_DOMAIN
	fi
	cat >"$destination" <<EOF
*.webxdc.${app_host} {
	tls {
		dns cloudflare {env.CLOUDFLARE_API_TOKEN}
		resolvers 1.1.1.1
	}
	root * ${dist_root}
	header {
		Content-Security-Policy "frame-ancestors https://${app_host}"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}
	encode zstd gzip
	rewrite * /webxdc-test.html
	file_server
}
EOF
}

receive_dist() {
	local staging=$1
	local archive=$staging/upload.tar.gz size entries invalid
	rm -rf -- "$staging"
	mkdir -p -- "$staging"
	head -c "$((MAX_UPLOAD_BYTES + 1))" >"$archive"
	size=$(stat -c %s -- "$archive")
	if (( size == 0 || size > MAX_UPLOAD_BYTES )); then
		rm -rf -- "$staging"
		die "upload must be between 1 and $MAX_UPLOAD_BYTES bytes"
	fi
	if ! tar -xzf "$archive" -C "$staging" --; then
		rm -rf -- "$staging"
		die "upload is not a valid gzip-compressed tar archive"
	fi
	rm -f -- "$archive"
	mapfile -t entries < <(find "$staging" -mindepth 1 -maxdepth 1 -printf '%f\n')
	if [ "${#entries[@]}" -ne 1 ] || [ "${entries[0]}" != dist ]; then
		rm -rf -- "$staging"
		die "archive must contain exactly one top-level dist directory"
	fi
	invalid=$(find "$staging" ! -type d ! -type f -print -quit)
	if [ -n "$invalid" ]; then
		rm -rf -- "$staging"
		die "archive contains a symlink or unsupported file type"
	fi
	if [ ! -f "$staging/dist/index.html" ]; then
		rm -rf -- "$staging"
		die "dist/index.html is missing"
	fi
	if [ ! -f "$staging/dist/caddy/routes.caddy" ]; then
		rm -rf -- "$staging"
		die "dist/caddy/routes.caddy is missing"
	fi
	# Old PR builds lack this temporary test page; preserve supplied versions.
	if [ ! -f "$staging/dist/webxdc-test.html" ]; then
		[ -f "$WEBXDC_FALLBACK" ] || die "webxdc fallback is missing"
		cp -- "$WEBXDC_FALLBACK" "$staging/dist/webxdc-test.html"
	fi
}

do_upload() {
	local target=$1 name parent dir staging route candidate_route webxdc_site candidate_webxdc
	local backup_dir backup_route backup_webxdc
	if [ "$target" = next ]; then
		name=next
		parent=$ROOT
	elif [[ "$target" =~ ^[0-9]+$ ]]; then
		name=pr-$target
		parent=$PREVIEWS
	else
		die "upload target must be a PR number or next"
	fi
	dir=$parent/$name
	staging=$parent/.incoming-$name
	route=$ROUTES/$name.caddy
	webxdc_site=$WEBXDC_SITES/$name.caddy
	candidate_route=$ROOT/.incoming-route-$name.caddy
	candidate_webxdc=$ROOT/.incoming-webxdc-$name.caddy
	backup_dir=$ROLLBACK/$name
	backup_route=$ROLLBACK/$name.caddy
	backup_webxdc=$ROLLBACK/webxdc-$name.caddy

	receive_dist "$staging"
	rm -f -- "$candidate_route" "$candidate_webxdc"
	write_route "$target" "$dir/dist" "$candidate_route"
	write_webxdc_site "$target" "$dir/dist" "$candidate_webxdc"
	rm -rf -- "$backup_dir"
	rm -f -- "$backup_route" "$backup_webxdc"
	if ! backup_slot "$dir" "$route" "$webxdc_site" "$backup_dir" "$backup_route" "$backup_webxdc"; then
		die "upload $name failed to back up previous deployment"
	fi
	if ! { mv -- "$staging" "$dir" && mv -- "$candidate_route" "$route" && mv -- "$candidate_webxdc" "$webxdc_site"; }; then
		restore_slot "$dir" "$route" "$webxdc_site" "$backup_dir" "$backup_route" "$backup_webxdc"
		die "upload $name failed to install; previous deployment restored"
	fi
	if ! validate_config; then
		restore_slot "$dir" "$route" "$webxdc_site" "$backup_dir" "$backup_route" "$backup_webxdc"
		die "upload $name failed Caddy validation; previous deployment restored"
	fi
	if ! reload_caddy; then
		restore_slot "$dir" "$route" "$webxdc_site" "$backup_dir" "$backup_route" "$backup_webxdc"
		reload_caddy || true
		die "upload $name failed Caddy reload; previous deployment restored"
	fi
	rm -rf -- "$backup_dir"
	rm -f -- "$backup_route" "$backup_webxdc"
	log "upload $name deployed and reloaded"
}

do_delete() {
	local target=$1 name dir route webxdc_site backup_dir backup_route backup_webxdc
	[[ "$target" =~ ^[0-9]+$ ]] || die "delete target must be a PR number"
	name=pr-$target
	dir=$PREVIEWS/$name
	route=$ROUTES/$name.caddy
	webxdc_site=$WEBXDC_SITES/$name.caddy
	backup_dir=$ROLLBACK/$name
	backup_route=$ROLLBACK/$name.caddy
	backup_webxdc=$ROLLBACK/webxdc-$name.caddy
	if [ ! -e "$dir" ] && [ ! -e "$route" ] && [ ! -e "$webxdc_site" ]; then
		log "delete $name: not deployed"
		return 0
	fi
	rm -rf -- "$backup_dir"
	rm -f -- "$backup_route" "$backup_webxdc"
	if ! backup_slot "$dir" "$route" "$webxdc_site" "$backup_dir" "$backup_route" "$backup_webxdc"; then
		die "delete $name failed to back up previous deployment"
	fi
	if ! validate_config || ! reload_caddy; then
		restore_slot "$dir" "$route" "$webxdc_site" "$backup_dir" "$backup_route" "$backup_webxdc"
		reload_caddy || true
		die "delete $name failed; previous deployment restored"
	fi
	rm -rf -- "$backup_dir"
	rm -f -- "$backup_route" "$backup_webxdc"
	log "delete $name removed and reloaded"
}

do_list() {
	find "$PREVIEWS" -mindepth 1 -maxdepth 1 -type d -name 'pr-*' -printf '%f\n' | sort
}

# Tests source the functions; only direct execution may take the deployment lock.
if [[ ${BASH_SOURCE[0]} != "$0" ]]; then
	return
fi
cd "$ROOT"
mkdir -p -- "$ROLLBACK"
exec 9>"$ROOT/.deploy.lock"
flock -w 300 9 || die "timed out waiting for deployment lock"
read -r -a argv <<<"${SSH_ORIGINAL_COMMAND:-}"
cmd=${argv[0]:-}
case "$cmd" in
	upload)
		[ "${#argv[@]}" -eq 2 ] || die "usage: upload <n|next>"
		do_upload "${argv[1]}"
		;;
	delete)
		[ "${#argv[@]}" -eq 2 ] || die "usage: delete <n>"
		do_delete "${argv[1]}"
		;;
	list)
		[ "${#argv[@]}" -eq 1 ] || die "usage: list"
		do_list
		;;
	*)
		die "refused command: ${SSH_ORIGINAL_COMMAND:-<empty>}"
		;;
esac
