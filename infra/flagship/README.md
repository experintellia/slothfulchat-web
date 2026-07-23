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

Manual upload roundtrip from a machine holding the deploy key:

    tar -C packages/web-app -czf - dist | ssh deploy@<host> "upload 1"   # -> https://pr-1.preview.slothful.chat
    ssh deploy@<host> "list"                                            # -> pr-1
    ssh deploy@<host> "delete 1"                                        # gone, cert renewals stop
