#!/usr/bin/env bash
# deploy-preview.sh — forced command for the preview/next deploy SSH key.
#
# TRUST MODEL
#   Installed as command="/usr/local/bin/deploy-preview.sh",restrict on the
#   deploy key in ~deploy/.ssh/authorized_keys, so the key can ONLY run this
#   script — never an arbitrary shell. CI (GitHub Actions) is NOT trusted with
#   server config: an upload carries a dist/ tarball on STDIN and nothing else.
#   The site-address-defining site.caddy is generated HERE, server-side, from a
#   validated PR number — uploads never carry site-address config. The server
#   validates the FULL merged config itself (caddy validate) and reloads only on
#   success, so a config that claims a protected hostname is a duplicate
#   site-address error and is rejected, leaving the previous config serving.
#   (Validate catches EXACT duplicate site addresses; a bundled routes.caddy
#   claiming an unused or wildcard hostname would pass — accepted, because the
#   bundle is repo-authored and only reaches here via same-repo PRs, the same
#   trust level as the codebase itself.)
#
# Dispatched from $SSH_ORIGINAL_COMMAND:
#   upload <n|next>   receive dist/ tarball on STDIN, stage, swap, validate, reload
#   delete <n>        remove pr-<n>, validate, reload (stops its cert renewals)
#   list              print pr-<n> directory names, one per line (cleanup sweep)

set -euo pipefail

# Env overrides exist for the self-test only; sshd doesn't pass client env to
# a forced command, so a CI caller can't reach them.
ROOT=${SLOTHFUL_DEPLOY_ROOT:-/srv/slothfulchat}
PREVIEWS=$ROOT/previews
CADDYFILE=${SLOTHFUL_DEPLOY_CADDYFILE:-/etc/caddy/Caddyfile}

log() { printf 'deploy-preview: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

# caddy validate needs no root (it only reads the config); reload does.
validate_and_reload() {
	caddy validate --config "$CADDYFILE" --adapter caddyfile || return 1
	sudo systemctl reload caddy
}

do_upload() {
	local target=$1 name parent dir staging site backup
	if [ "$target" = next ]; then
		name=next
		parent=$ROOT
	elif [[ "$target" =~ ^[0-9]+$ ]]; then
		name=pr-$target
		parent=$PREVIEWS
	else
		die "upload: invalid target '$target' (expected a number or 'next')"
	fi
	dir=$parent/$name
	staging=$parent/.incoming-$name

	# Fresh staging dir (wipe any stale leftover from a crashed run).
	rm -rf -- "$staging"
	mkdir -p -- "$staging"

	# Extract the dist/ tarball from STDIN into staging. Traversal containment
	# is GNU tar's doing, not the staging location's (staging is a SIBLING of
	# the live slots): tar >= 1.29 refuses member names with ".." and strips
	# absolute paths by default — this script assumes GNU tar. ponytail: no
	# stream size cap — CI is semi-trusted (forced-command key). Add `head -c`
	# before tar if an untrusted uploader is ever wired in.
	tar -xzf - -C "$staging" --

	# Reject anything but a single top-level dist/ directory.
	local entries
	mapfile -t entries < <(find "$staging" -mindepth 1 -maxdepth 1 -printf '%f\n')
	if [ "${#entries[@]}" -ne 1 ] || [ "${entries[0]}" != dist ]; then
		rm -rf -- "$staging"
		die "upload: tarball must contain exactly one top-level 'dist/' (got: ${entries[*]:-nothing})"
	fi
	if [ ! -f "$staging/dist/caddy/routes.caddy" ]; then
		rm -rf -- "$staging"
		die "upload: dist/caddy/routes.caddy missing from tarball"
	fi
	# file_server follows symlinks, so a link in the tarball could serve out
	# anything the caddy user can read — reject them outright.
	if find "$staging" -type l -print -quit | grep -q .; then
		rm -rf -- "$staging"
		die "upload: symlinks are not allowed in the tarball"
	fi

	# Swap, keeping the previous slot in $ROOT/.rollback until validate passes:
	# if the new bundle's routes.caddy doesn't validate, the on-disk config
	# must end up loadable again (the static next import and the preview glob
	# point into these dirs) — otherwise the next caddy RESTART (reboot,
	# upgrade) would fail config load and take down every site on the box,
	# even though the running instance kept serving from memory.
	# The backup lives OUTSIDE previews/ deliberately: a pr-N.old sibling
	# would still match the `previews/*/site.caddy` glob (Go's filepath.Glob
	# `*` matches dots too), and its stale site.caddy would make every update
	# of a deployed slot a duplicate-hostname validate error.
	backup=$ROOT/.rollback/$name
	rm -rf -- "$backup"
	mkdir -p -- "$ROOT/.rollback"
	if [ -e "$dir" ]; then mv -- "$dir" "$backup"; fi
	mv -- "$staging" "$dir"

	if [ "$name" != next ]; then
		# PR preview: generate the one-line site wrapper server-side, from the
		# validated number only — the host address is never taken from the
		# upload. (next's import is static in the flagship Caddyfile instead.)
		site=$dir/site.caddy
		printf 'import %s/dist/caddy/routes.caddy pr-%s.preview.slothful.chat %s/dist\n' \
			"$dir" "$target" "$dir" >"$site"
	fi

	if ! validate_and_reload; then
		rm -rf -- "$dir"
		if [ -e "$backup" ]; then mv -- "$backup" "$dir"; fi
		die "upload $name: caddy validate failed; previous deployment restored"
	fi
	rm -rf -- "$backup"
	log "upload $name: deployed and reloaded"
}

do_delete() {
	local n=$1
	[[ "$n" =~ ^[0-9]+$ ]] || die "delete: invalid pr number '$n' (next is not deletable)"
	if [ ! -d "$PREVIEWS/pr-$n" ]; then
		# close event + weekly sweep can both fire — nothing to do, no reload
		log "delete pr-$n: not deployed, nothing to do"
		return 0
	fi
	rm -rf -- "$PREVIEWS/pr-$n"   # dist/ and site.caddy both go with the folder
	validate_and_reload || die "delete pr-$n: removed folder but caddy validate failed"
	log "delete pr-$n: removed and reloaded"
}

do_list() {
	# pr-<n> directory names only; _keep and .incoming-* don't match, and
	# rollback backups live outside previews/ entirely.
	find "$PREVIEWS" -mindepth 1 -maxdepth 1 -type d -name 'pr-*' -printf '%f\n' | sort
}

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
		die "refused: only 'upload <n|next>', 'delete <n>', 'list' are permitted (got: ${SSH_ORIGINAL_COMMAND:-<empty>})"
		;;
esac
