# Flagship server bring-up

The `next.slothful.chat` + PR-preview server. No server exists yet — this is the
checklist to create one. The GitHub workflows no-op until step (h) arms them, so
nothing here is on the critical path for shipping the app.

Files in this dir are **reference copies**; they get placed on the server by
hand during bring-up (`Caddyfile` → `/etc/caddy/Caddyfile`, `deploy-preview.sh`
→ `/usr/local/bin/`).

## (a) Provision a box

Any small Linux VM with a public IPv4. Open 80 + 443.

## (b) Install Caddy with both DNS plugins

Wildcard certs (`*.webxdc.*`) need the DNS-01 challenge, which needs the
provider plugin compiled in. Build with xcaddy:

    xcaddy build --with github.com/caddy-dns/porkbun --with github.com/caddy-dns/cloudflare

Put the binary at `/usr/bin/caddy`. (Docker equivalent: a `FROM caddy:builder`
stage running the same `xcaddy build ...` line, copied into `FROM caddy`.)

## (c) DNS records at the provider

    next.slothful.chat            A   -> server IP
    *.webxdc.next.slothful.chat   A   -> server IP
    *.preview.slothful.chat       A   -> server IP

DNS wildcards match **multiple** labels (RFC 4592), so `*.preview` also resolves
`pr-123.preview…`, `<slug>.webxdc.pr-123.preview…`, etc. — one record covers the
whole preview tree. (TLS certs match exactly one label, RFC 6125, so certs are
still per-name — that's Caddy's job, not DNS's.)

Cloudflare caveat: these wildcards must be **DNS-only / grey-cloud**. Proxied
(orange-cloud) wildcards are one level only (Universal SSL) and would also
intercept TLS — but Caddy terminates TLS here, so proxying must stay off.

Do **not** add an explicit record at `pr-N.preview…`: it would shadow the
wildcard for every name below it.

## (d) Filesystem

    sudo useradd -r -m -d /srv/slothfulchat deploy
    sudo -u deploy mkdir -p /srv/slothfulchat/next /srv/slothfulchat/previews/_keep

Create the permanent sentinel so the preview glob is never empty:

    printf '# keep — do not delete. Guarantees previews/*/site.caddy matches\n# at least one file so caddy config load never breaks on an empty dir.\n' \
      | sudo -u deploy tee /srv/slothfulchat/previews/_keep/site.caddy

The main Caddyfile imports `previews/*/site.caddy`; the glob targets
`*/site.caddy`, so this `_keep/site.caddy` (comment-only) always matches while
no PR does. `deploy-preview.sh list` skips `_keep`.

## (e) Deploy user, forced-command key, gate script, sudoers

Gate-script prerequisites — it treats every upload as untrusted input, so these
are not optional; a missing one makes the gate fail closed and every deploy
break:

- **`python3`** — walks the adapted-JSON allowlist that vets each bundle's
  `routes.caddy` (see the TRUST MODEL in `deploy-preview.sh`). Preinstalled on
  Ubuntu Server and on Debian cloud images; on a truly minimal Debian,
  `sudo apt-get install -y python3`. Chosen over `jq` because the check needs
  `..` collapsed before comparing path prefixes (`os.path.normpath`), and
  because it is one fewer thing to install here.
- **GNU tar ≥ 1.29** and **GNU coreutils** (`stat`, `timeout`, `head`, `find`,
  `awk`) — traversal refusal and the archive size/entry limits. Both are the
  distro default on Debian/Ubuntu.
- **`caddy`** on `deploy`'s `PATH` — the gate runs `caddy adapt` and
  `caddy validate` unprivileged, from the same binary built in step (b).
- **`flock`** (util-linux) and **`curl`** — the server-wide deploy lock and the
  post-reload health check (below). Both are distro default; without them every
  deploy fails closed rather than deploying unserialised or unchecked.

Two things happen around every upload and delete, and both matter operationally:

- **One lock for the whole box** (`/srv/slothfulchat/.deploy.lock`). Uploads and
  deletes mutate one shared Caddy config, and the GitHub concurrency groups only
  serialise per PR — so the gate serialises server-side instead, holding the
  lock for the entire transaction. A deploy that waits more than 15 minutes for
  it gives up rather than queueing forever.
- **A health check before the rollback copy is dropped.** `caddy validate`
  answers "does this config load", never "does this site serve": a slot whose
  files never landed, whose directory `caddy` cannot read, or whose wildcard
  cert never issued validates and reloads perfectly. So after the reload the
  gate requests `https://<slot-host>/` — and, for the wildcard the bundle
  claims, `https://deploy-health.webxdc.<slot-host>/` — against this box's own
  listener, retrying for up to 3 minutes. Only then is the previous deployment
  deleted; if it never answers, the previous deployment is restored and
  reloaded. A first deploy of a new PR slot spends part of that window waiting
  on DNS-01 issuance for the wildcard, which is expected.

Install the gate script:

    sudo install -m 0755 deploy-preview.sh /usr/local/bin/deploy-preview.sh

Add the deploy public key to `~deploy/.ssh/authorized_keys` as a forced command
(one line; the private half becomes the `PREVIEW_SSH_KEY` secret in step h):

    command="/usr/local/bin/deploy-preview.sh",restrict ssh-ed25519 AAAA…deploy-key… ci@slothful

`restrict` drops pty/forwarding/agent; `command=` pins every invocation to the
gate script regardless of what SSH_ORIGINAL_COMMAND asks for.

Narrow sudoers — reload only (validate reads the config unprivileged, so it
needs no sudo; just make sure `/etc/caddy/Caddyfile` and `/srv/slothfulchat` are
readable by `deploy`):

    # /etc/sudoers.d/deploy-caddy  (visudo -f)
    deploy ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy

(Confirm the path with `command -v systemctl`.)

### Disk quota for `/srv/slothfulchat` (operator action)

The gate script caps every upload (128 MiB compressed on the wire, 512 MiB of
declared content, 20 000 members — see the constants at the top of
`deploy-preview.sh`), which stops a single archive from filling the disk. It
does **not** bound the sum of many slots: enough concurrent PRs, each within
budget, still add up. That ceiling belongs to the filesystem, not the script.

Put `/srv/slothfulchat` on its own filesystem, or give `deploy` a quota, so a
full previews tree can never take `next`, Caddy's cert storage or the system
journal down with it:

    # ext4/xfs with quotas enabled (mount option usrquota / uquota)
    sudo setquota -u deploy 20G 24G 0 0 /srv

Sizing: a preview slot is ~100 MB, so 20 GB is ~200 concurrent PRs — well past
what `preview-cleanup.yml` ever leaves lying around.

## (f) Provider API token via systemd drop-in

    # /etc/systemd/system/caddy.service.d/dns-token.conf
    [Service]
    Environment=CLOUDFLARE_API_TOKEN=…        # or PORKBUN_API_KEY/PORKBUN_API_SECRET_KEY

    sudo systemctl daemon-reload

## (g) Place and start Caddy

    sudo install -m 0644 Caddyfile /etc/caddy/Caddyfile

Then edit `/etc/caddy/Caddyfile`: fill the `email`, uncomment your provider
block in `(wildcard_tls)`. Leave the `next` import commented until next has been
deployed at least once (step h wires that up). Validate and start:

    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
    sudo systemctl enable --now caddy

## (h) Arm the GitHub side

The preview/next workflows gate on a repo **Variable**, so they no-op until it
is set. In repo Settings → Secrets and variables → Actions:

- Variable `PREVIEW_SSH_HOST` — server host or IP.
- Variable `PREVIEW_SSH_HOSTKEY` — output of `ssh-keyscan -t ed25519 <host>`
  (the full `known_hosts` line).
- Secret `PREVIEW_SSH_KEY` — the deploy key's **private** half from step (e).

Once `PREVIEW_SSH_HOST` is set, the first push to `main` deploys next; uncomment
the `next` import in `/etc/caddy/Caddyfile` and reload after that first deploy.

Upload path used by the workflows (do not change without updating them):

    tar -C packages/web-app -czf - dist | ssh deploy@$PREVIEW_SSH_HOST "upload <n|next>"

## (i) Smoke tests

Hostile-config test — the gate must reject config that claims a protected host.
Hand-craft a bad site block and confirm `caddy validate` fails (the gate runs
exactly this before any reload, so a rejected validate leaves the old config
serving):

    mkdir -p /srv/slothfulchat/previews/pr-evil
    printf 'web.slothful.chat {\n\trespond "pwned"\n}\n' \
      | sudo -u deploy tee /srv/slothfulchat/previews/pr-evil/site.caddy
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile   # must FAIL
    sudo rm -rf /srv/slothfulchat/previews/pr-evil

(Uploads can't actually do this — the gate generates site.caddy itself from the
PR number and only accepts a `dist/` tarball — but the test proves validate is
the backstop.)

Hostile-bundle test — validate is only the backstop; the check that matters is
the allowlist the gate runs over the *adapted* config of the `routes.caddy`
inside the upload. Prove it rejects, and that `caddy validate` alone would not:

    printf '{args[0]} {\n\troot * {args[1]}\n\treverse_proxy localhost:2019\n}\n' \
      > /tmp/evil-routes.caddy
    tar -C /tmp -czf - --transform 's|evil-routes.caddy|dist/caddy/routes.caddy|' \
      evil-routes.caddy | ssh deploy@<host> "upload 1"   # must FAIL: "routes.caddy rejected"

The full matrix (reverse_proxy, `{env.*}`, escaping `root`, `file_server
browse`, a foreign hostname, and oversized/over-count/sparse archives) is
covered offline by `bash infra/flagship/test-deploy-preview.sh`, which needs
only a `caddy` binary — run that after any change to the gate script.

Manual upload roundtrip from a machine holding the deploy key:

    tar -C packages/web-app -czf - dist | ssh deploy@<host> "upload 1"   # -> https://pr-1.preview.slothful.chat
    ssh deploy@<host> "list"                                            # -> pr-1
    ssh deploy@<host> "delete 1"                                        # gone, cert renewals stop
