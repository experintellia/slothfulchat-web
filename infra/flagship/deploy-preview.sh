#!/usr/bin/env bash
# deploy-preview.sh — forced command for the preview/next deploy SSH key.
#
# TRUST MODEL
#   Installed as command="/usr/local/bin/deploy-preview.sh",restrict on the
#   deploy key in ~deploy/.ssh/authorized_keys, so the key can ONLY run this
#   script — never an arbitrary shell. CI (GitHub Actions) is NOT trusted with
#   server config: an upload carries a dist/ tarball on STDIN and nothing else.
#   The site-address-defining site.caddy is generated HERE, server-side, from a
#   validated PR number — uploads never carry site-address config.
#
#   THE UPLOADED BUNDLE IS UNTRUSTED. It is repo-authored and same-repo-PR
#   gated, but "authored in the repo" is not "reviewed before it runs as root's
#   webserver config": a PR is built and deployed the moment it is pushed, long
#   before anyone reads it. And dist/caddy/routes.caddy is real Caddy config
#   that the flagship Caddyfile imports — a `reverse_proxy localhost:2019`
#   (Caddy's admin API), a `respond "{env.PORKBUN_API_KEY}"` (the DNS
#   credential in caddy.service's environment), a `root * /etc` + `file_server
#   browse`, or a site block claiming an unused hostname all pass `caddy
#   validate` with exit 0. Validate only answers "is this loadable", never "is
#   this allowed". So every upload's routes.caddy is inspected here first, and
#   only a bundle that survives inspection is swapped in — see inspect_routes.
#
#   MAINTENANCE COST, stated plainly because it WILL bite: inspect_routes is a
#   fail-closed allowlist over what routes.caddy adapts to today. It must be
#   revisited whenever routes.caddy legitimately grows a directive (new handler
#   name in the JSON), and whenever a Caddy upgrade changes the adapted shape
#   (new keys on a server, a renamed handler). Both show up the same way: a
#   deploy that suddenly fails with "routes.caddy rejected: ...". Breaking a
#   deploy is the correct failure mode — widen the allowlist deliberately, in a
#   commit, rather than making the check advisory.
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

# Upload budget. A real dist/ is ~7 MB of static overlays + a ~10 MB
# NotoColorEmoji.ttf + ~7 MB of emoji-set fonts + upstream's bundle + locales +
# the release wasm core: order 100 MB expanded, well under a few thousand
# files, and it gzips several-fold. Every number below is a generous multiple
# of that, chosen so a real build never comes close and a bomb never lands:
MAX_TGZ_BYTES=134217728    # 128 MiB compressed on the wire
MAX_ENTRIES=20000          # members in the archive
MAX_ENTRY_BYTES=134217728  # 128 MiB declared by any one member
MAX_TOTAL_BYTES=536870912  # 512 MiB declared across all members
TAR_TIMEOUT=120            # seconds, per tar pass

log() { printf 'deploy-preview: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }

# caddy validate needs no root (it only reads the config); reload does.
validate_and_reload() {
	caddy validate --config "$CADDYFILE" --adapter caddyfile || return 1
	sudo systemctl reload caddy
}

# inspect_routes <dist-dir> <host> — allowlist the bundled routes.caddy.
#
# `caddy validate` is not an authorisation check (see TRUST MODEL), so we look
# at what the config MEANS instead: `caddy adapt` lowers the Caddyfile to the
# JSON config caddy actually runs, with imports and snippets already expanded
# and every directive turned into a named handler — no textual import-chasing,
# no regex over Caddyfile syntax (which is bypassable: comments, quoting,
# heredocs, another import). Then we allowlist that JSON.
#
# Adapting is itself safe: {env.*} and {file.*} are resolved when caddy RUNS,
# not when it adapts, so they survive into the JSON as literal strings — which
# is exactly how we detect them, without ever expanding them.
#
# The wrapper we adapt is generated here, so the args (hostname, dist root) are
# ours; only routes.caddy's body comes from the upload. It defines an EMPTY
# (wildcard_tls) snippet: routes.caddy imports that name, and we are inspecting
# routes.caddy, not the server's real cert config (whose DNS credential
# placeholders would trip the {env.*} check).
#
# python3 over jq: the root-confinement check needs "../.." collapsed before
# comparing prefixes, which is os.path.normpath in the stdlib and hand-rolled
# string surgery in jq. python3 also ships on the Ubuntu/Debian server images
# this box is built from, so it is one less thing to install (see README).
inspect_routes() {
	local dist=$1 host=$2 wrapper json rc=0
	wrapper=$(mktemp)
	json=$(mktemp)
	printf '(wildcard_tls) {\n}\nimport %s/caddy/routes.caddy %s %s\n' "$dist" "$host" "$dist" >"$wrapper"
	caddy adapt --config "$wrapper" --adapter caddyfile >"$json" || rc=$?
	if [ "$rc" -ne 0 ]; then
		rm -f -- "$wrapper" "$json"
		log "upload: bundled routes.caddy does not adapt"
		return 1
	fi
	python3 - "$json" "$dist" "$host" <<'PY' || rc=$?
import json
import os
import sys

cfg_path, dist_root, host = sys.argv[1:4]

# Exactly what packages/web-app/caddy/routes.caddy adapts to today — nothing
# speculative. A directive added there adds its handler name here, in the same
# commit; anything else is an upload trying to do something routes.caddy has
# never done.
ALLOWED_HANDLERS = {"subroute", "vars", "encode", "error", "file_server", "rewrite"}
# The two site addresses this slot owns, and no others. Every other name on the
# box (next, prod, another PR's slot) is off limits.
ALLOWED_HOSTS = {host, "*.webxdc." + host}

raw = open(cfg_path, encoding="utf-8").read()


def reject(why):
    sys.exit("routes.caddy rejected: " + why)


for placeholder in ("{env.", "{file."):
    if placeholder in raw:
        reject("uses a %s placeholder — it would read the server's environment "
               "or filesystem at request time" % placeholder)


def keys_within(obj, allowed, what):
    if not isinstance(obj, dict):
        reject("%s is not an object" % what)
    unknown = sorted(set(obj) - allowed)
    if unknown:
        reject("%s has unexpected key(s): %s" % (what, ", ".join(unknown)))


def walk(node):
    """Handler / browse / root checks, anywhere in the tree."""
    if isinstance(node, list):
        for item in node:
            walk(item)
        return
    if not isinstance(node, dict):
        return
    handler = node.get("handler")
    if handler is not None:
        if handler not in ALLOWED_HANDLERS:
            reject("uses the %r handler" % handler)
        if handler == "file_server" and "browse" in node:
            reject("enables file_server browse — it would index the whole slot")
    if "root" in node:
        root = node["root"]
        if not isinstance(root, str):
            reject("has a non-string root %r" % (root,))
        # normpath collapses "..", so {args[1]}/../../etc cannot sneak past a
        # plain prefix test. Symlinked escapes are covered separately: the
        # upload may not contain symlinks at all.
        resolved = os.path.normpath(root)
        if resolved != dist_root and not resolved.startswith(dist_root + os.sep):
            reject("serves %r, outside this slot's %s" % (root, dist_root))
    for value in node.values():
        walk(value)


try:
    cfg = json.loads(raw)
    dist_root = os.path.normpath(dist_root)
    # Shape: one http app, port 443 only, every site block bound to a hostname
    # this slot owns. keys_within is what makes it fail closed — an unexpected
    # key (a `tls` app from a `tls` directive, an `automatic_https` skip from
    # an http:// site address, whatever a future Caddy grows) is a rejection,
    # not a shrug.
    keys_within(cfg, {"apps"}, "adapted config")
    keys_within(cfg["apps"], {"http"}, "apps")
    keys_within(cfg["apps"]["http"], {"servers"}, "http app")
    for name, server in cfg["apps"]["http"]["servers"].items():
        keys_within(server, {"listen", "routes"}, "server %s" % name)
        if server["listen"] != [":443"]:
            reject("server %s listens on %r" % (name, server["listen"]))
        for route in server["routes"]:
            if not route.get("match"):
                reject("has a site block matching every hostname (catch-all)")
            for matcher in route["match"]:
                keys_within(matcher, {"host"}, "site matcher")
                for site in matcher["host"]:
                    if site not in ALLOWED_HOSTS:
                        reject("claims the site address %r" % site)
    walk(cfg)
except (ValueError, LookupError, TypeError, AttributeError) as exc:
    # Fail closed. Unparseable JSON, or a shape this checker does not
    # recognise, rejects the upload — breaking a deploy beats loading config
    # nobody inspected. (reject() raises SystemExit, so it is not caught here.)
    reject("adapted config has an unrecognised shape (%s: %s)"
           % (type(exc).__name__, exc))
PY
	rm -f -- "$wrapper" "$json"
	return "$rc"
}

do_upload() {
	local target=$1 name parent host dir staging archive site backup
	if [ "$target" = next ]; then
		name=next
		parent=$ROOT
		host=next.slothful.chat
	elif [[ "$target" =~ ^[0-9]+$ ]]; then
		name=pr-$target
		parent=$PREVIEWS
		host=pr-$target.preview.slothful.chat
	else
		die "upload: invalid target '$target' (expected a number or 'next')"
	fi
	dir=$parent/$name
	staging=$parent/.incoming-$name
	archive=$parent/.incoming-$name.tgz

	# One cleanup for both scratch paths, covering every exit: die, set -e, and
	# the success path (where $staging has already been moved away, so the rm is
	# a no-op). Expanded NOW, not at trap time — these are function locals and
	# are long out of scope by the time an EXIT trap runs. Neither path can
	# match the Caddyfile's previews/*/site.caddy glob: one is a plain file, the
	# other holds no site.caddy until it becomes a slot.
	trap "rm -rf -- '$staging' '$archive'" EXIT

	# Fresh staging dir (wipe any stale leftover from a crashed run).
	rm -rf -- "$staging" "$archive"
	mkdir -p -- "$staging"

	# --- resource limits, enforced BEFORE anything grows on disk -------------
	# The uploader is untrusted (see TRUST MODEL) and this box also carries
	# `next`, every other preview, and Caddy's cert storage: filling its disk
	# takes all of that down, not just the offending deploy.
	#
	# Cap the compressed stream first, then read the member list — which reports
	# each member's DECLARED logical size, and that is the number that exposes a
	# sparse bomb (a 176-byte archive can declare an 8 GiB member; only the
	# declaration is visible before extraction). Extract only once the
	# declarations fit the budget.
	#
	# Both tar passes run under `timeout`: 128 MiB of gzip can decode to
	# terabytes, and merely skipping through that is minutes of CPU even when
	# nothing is written. head -c truncates at the cap rather than failing, so a
	# stream that fills it exactly is treated as over-limit.
	head -c "$MAX_TGZ_BYTES" >"$archive"
	[ "$(stat -c %s -- "$archive")" -lt "$MAX_TGZ_BYTES" ] \
		|| die "upload: compressed tarball exceeds $MAX_TGZ_BYTES bytes"
	timeout "$TAR_TIMEOUT" tar -tzvf "$archive" | awk \
		-v max_entries="$MAX_ENTRIES" \
		-v max_entry="$MAX_ENTRY_BYTES" \
		-v max_total="$MAX_TOTAL_BYTES" '
		function bad(msg) { print "deploy-preview: upload: " msg > "/dev/stderr"; failed = 1; exit 1 }
		{
			# tar -tv leads with the type character: "-" regular, "d" directory,
			# "l" symlink, "h" hardlink, "c"/"b"/"p"/"s" device or socket. Only
			# the first two have any business in a dist/.
			type = substr($1, 1, 1)
			if (type != "-" && type != "d")
				bad("member of type \"" type "\" not allowed: " $NF)
			if (++entries > max_entries)
				bad("archive declares more than " max_entries " members")
			size = $3 + 0
			if (size > max_entry)
				bad("member declares " size " bytes (limit " max_entry "): " $NF)
			total += size
			if (total > max_total)
				bad("members declare more than " max_total " bytes in total")
		}
		END { if (failed) exit 1 }
	' || die "upload: tarball rejected before extraction"

	# Extract the dist/ tarball into staging. Traversal containment is GNU tar's
	# doing, not the staging location's (staging is a SIBLING of the live
	# slots): tar >= 1.29 refuses member names with ".." and strips absolute
	# paths by default — this script assumes GNU tar.
	timeout "$TAR_TIMEOUT" tar -xzf "$archive" -C "$staging" -- \
		|| die "upload: extraction failed or timed out"

	# Reject anything but a single top-level dist/ directory.
	local entries
	mapfile -t entries < <(find "$staging" -mindepth 1 -maxdepth 1 -printf '%f\n')
	if [ "${#entries[@]}" -ne 1 ] || [ "${entries[0]}" != dist ]; then
		die "upload: tarball must contain exactly one top-level 'dist/' (got: ${entries[*]:-nothing})"
	fi
	if [ ! -f "$staging/dist/caddy/routes.caddy" ]; then
		die "upload: dist/caddy/routes.caddy missing from tarball"
	fi
	# file_server follows symlinks, so a link in the tarball could serve out
	# anything the caddy user can read — reject them outright. The member-type
	# check above already refuses them from the header; this confirms it against
	# what actually landed on disk, which is a different claim.
	if find "$staging" -type l -print -quit | grep -q .; then
		die "upload: symlinks are not allowed in the tarball"
	fi

	# Allowlist the bundled routes.caddy while it is still in staging, so a
	# rejected bundle never touches the live slot at all — the previous
	# deployment keeps serving, untouched, with no swap to roll back.
	inspect_routes "$staging/dist" "$host" || die "upload $name: routes.caddy rejected"

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
		printf 'import %s/dist/caddy/routes.caddy %s %s/dist\n' \
			"$dir" "$host" "$dir" >"$site"
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
