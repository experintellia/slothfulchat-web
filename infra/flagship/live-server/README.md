# Live preview server (lollolollol.lol)

The running `next` + PR-preview server is **not** set up from `../Caddyfile` and
`../deploy-preview.sh` (those target `preview.slothful.chat` and are not installed
there). It runs its own gate, which until now existed only on the server. These
files are that gate's source of truth, with nested webxdc hosts fixed:

- `Caddyfile` → `/etc/caddy/Caddyfile`
- `deploy-preview.sh` → `/usr/local/bin/deploy-preview.sh` (forced command)
- `test-routes.sh` — offline check, run after any change: `bash test-routes.sh`

## What was broken

The app opens a webxdc at `https://<app-id>.webxdc.pr-<n>.lollolollol.lol/`. The
old gate only wrote route fragments imported *inside* the `*.lollolollol.lol`
site, so:

1. **TLS failed.** A wildcard cert covers one label; `*.lollolollol.lol` cannot
   serve `<app-id>.webxdc.pr-<n>.…`, and nothing requested a cert that could.
2. **The matcher was the wrong scheme.** It accepted only flat
   `webxdc-pr-<n>-[a-z0-9]+.lollolollol.lol`, which the app never generates and
   which rejects app ids with a hyphen (`3214-324`).
3. **Some bundles lack `webxdc-test.html`** (PR 287 and 299 at inspection), so
   even a routed request hit a 404.

The new gate also writes `webxdc-sites/<slot>.caddy` per deploy: a top-level
`*.webxdc.<app-host>` site with its own DNS-01 wildcard cert and the
`frame-ancestors https://<app-host>` header from
`packages/web-app/caddy/routes.caddy`. Upload and delete maintain it with the
same rollback as the slot. A bundle without `webxdc-test.html` gets the
server-owned copy in `/srv/slothfulchat/shared/`. The flat route is kept for
links already in circulation.

## Install (operator, reviewed first)

Copy the candidates to the server:

```sh
ssh root@pr-287.lollolollol.lol 'mkdir -p /root/live-webxdc-fix'
scp infra/flagship/live-server/Caddyfile infra/flagship/live-server/deploy-preview.sh \
  packages/web-app/static/webxdc-test.html root@pr-287.lollolollol.lol:/root/live-webxdc-fix/
```

On the server, under the deploy lock, back up, install, generate sites for every
deployed slot, swap the Caddyfile last; any failure restores both files and
reloads the old config:

```sh
set -euo pipefail
exec 9>/srv/slothfulchat/.deploy.lock
flock -x 9
cp -a /etc/caddy/Caddyfile /root/live-webxdc-fix/Caddyfile.before
cp -a /usr/local/bin/deploy-preview.sh /root/live-webxdc-fix/deploy-preview.sh.before
rollback() {
  trap - ERR
  install -m 0644 /root/live-webxdc-fix/Caddyfile.before /etc/caddy/Caddyfile
  install -m 0755 /root/live-webxdc-fix/deploy-preview.sh.before /usr/local/bin/deploy-preview.sh
  sudo -u caddy /usr/local/libexec/slothful-caddy-validate
  systemctl reload caddy
}
trap rollback ERR
install -d -o deploy -g deploy -m 0755 /srv/slothfulchat/webxdc-sites /srv/slothfulchat/shared
printf '# Keep the wildcard-site import valid when no previews are deployed.\n' \
  | install -m 0644 -o deploy -g deploy /dev/stdin /srv/slothfulchat/webxdc-sites/_keep.caddy
install -m 0644 -o deploy -g deploy /root/live-webxdc-fix/webxdc-test.html \
  /srv/slothfulchat/shared/webxdc-test.html
install -m 0755 /root/live-webxdc-fix/deploy-preview.sh /usr/local/bin/deploy-preview.sh
source /usr/local/bin/deploy-preview.sh
for slot in /srv/slothfulchat/next /srv/slothfulchat/previews/pr-*; do
  [ -d "$slot/dist" ] || continue
  name=${slot##*/}
  target=${name#pr-}
  write_webxdc_site "$target" "$slot/dist" "/srv/slothfulchat/webxdc-sites/$name.caddy"
  chown deploy:deploy "/srv/slothfulchat/webxdc-sites/$name.caddy"
  if [ ! -f "$slot/dist/webxdc-test.html" ]; then
    install -m 0644 -o deploy -g deploy /srv/slothfulchat/shared/webxdc-test.html \
      "$slot/dist/webxdc-test.html"
  fi
done
install -m 0644 /root/live-webxdc-fix/Caddyfile /etc/caddy/Caddyfile
sudo -u caddy /usr/local/libexec/slothful-caddy-validate
systemctl reload caddy
trap - ERR
```

The first reload requests one wildcard cert per deployed slot (11 at
inspection), so issuance can lag. Check Caddy's cert logs and retry; never prove
it with `curl -k`. Keep the backups until HTTPS is verified. Manual rollback:

```sh
install -m 0644 /root/live-webxdc-fix/Caddyfile.before /etc/caddy/Caddyfile
install -m 0755 /root/live-webxdc-fix/deploy-preview.sh.before /usr/local/bin/deploy-preview.sh
sudo -u caddy /usr/local/libexec/slothful-caddy-validate
systemctl reload caddy
```

## Acceptance

- `https://pr-287.lollolollol.lol/` still serves the app; `/caddy/*` is 404.
- `https://3214-324.webxdc.pr-287.lollolollol.lol/` and
  `https://anything.webxdc.pr-287.lollolollol.lol/` complete TLS with a matching
  cert and serve the isolation test page; two app ids keep separate
  localStorage.
- An unrelated hostname still gets the fallback 404; another PR number gets its
  own hosts without claiming PR 287's.
