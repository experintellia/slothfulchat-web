# Collecting crash reports

When the wasm core fails to start there is no app left to report from, and the
anonymous usage statistics deliberately cannot carry an arbitrary error string
(`packages/web-app/src/events.ts` is a closed catalogue). A counter that says
"this happened 300 times" is the wrong instrument for the one failure kind that
is a real bug rather than a known condition. So the error screen asks the user
to send the error instead — see [issue #176](https://github.com/experintellia/slothfulchat-web/issues/176).

Entirely optional. Configure nothing and the screen still shows the error and
offers to copy it; this document is about turning those copies into reports
that reach you.

## What a report contains

```
failure: init-error
details: Error: sahpool install failed: NotFoundError install@…/worker.js:311:9
build: 0.8.1 c381266f
origin: https://pr-42.preview.slothful.chat
display: standalone
browser: Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) …
```

| Line | What it is | When |
|---|---|---|
| `failure` | `opfs-locked`, `storage-blocked`, `init-error`, `no-wasm`, `migration-error` | always |
| `details` | the worker's error text **and its stack** | `init-error` |
| `build` | app version + 8-character commit | release builds |
| `origin` | which deployment — prod, a staging slot, `pr-<n>` for a preview | always |
| `display` | `standalone` (installed PWA) or `browser` | always |
| `browser` | `navigator.userAgent` | always |

`opfs-locked` and `storage-blocked` carry no `details`: each has one known
cause ("already open in another tab", "cookies/site data blocked"), so their
*rate* is the whole signal and there is no error text worth having.

The stack is what makes the rest actionable — `NotFoundError` alone has several
plausible origins (the sahpool install, the wasm fetch, a self-heal that gave
up) and only the frames say which. The `origin` line is what stops a crash in a
PR preview from being read as a crash in prod, since both can carry the same
version.

Composed by `fatalReportText()` in `packages/web-app/src/fatal-report.ts`,
which is DOM-free and unit-tested next door.

## The two destinations

Each variable adds one button to the error screen, beside "Copy details". Set
either, both, or neither.

| Variable | Button | Costs the user |
|---|---|---|
| `SLOTHFUL_SUPPORT_URL` | **Open an issue** | an account on the tracker, and the report is public there |
| `SLOTHFUL_CRASH_REPORT_URL` | **Send to the developers** | nothing — no account, not public |

Both live behind a **"Technical details"** disclosure, together with the report
they would send — expanding it is what shows the user the text, so nothing can
be sent unseen. It starts collapsed when the failure is one the user can fix
(`opfs-locked`, `storage-blocked`, `no-wasm` each come with a step that fixes
them) so that step stays the biggest thing on the screen, and expanded when the
failure is ours (`init-error`, `worker-died`), where there is no first aid and
the report is the only useful thing. That default is emphasis only: every kind
keeps its buttons, because these detections can be wrong, and a user told to
close a tab they never opened is looking at our bug with no other way to reach
us.

The note states what the tracker costs before either button is pressed, because
it is a screen the user cannot go back from. The no-account button renders first: it is
the one most people can actually finish, and having to sign up is the single
likeliest reason a crash report never arrives.

**Neither has a default.** An unconfigured self-hosted instance shows no button
at all rather than sending your users to this repo's tracker — and "no button"
rather than a dead one, because on a screen where nothing works a button that
goes nowhere is worse than none.

Both work the same way: the report is appended as `?title=&body=`. Those are
GitHub's own new-issue parameters, so a tracker URL needs no glue, and they are
an ordinary query, so anything that can read a query string can be the other
destination. A query the URL already carries is kept, so
`…/issues/new?labels=bug` arrives pre-labelled.

```sh
SLOTHFUL_SUPPORT_URL=https://github.com/you/your-fork/issues/new?labels=bug
SLOTHFUL_CRASH_REPORT_URL=https://report.example.chat/
```

Values must be a single clean `http(s)` URL; anything else (a `mailto:`, a
value with a space) is treated as unset. Configuring either adds a section to
the generated `privacy.html` naming the recipient.

## A destination that needs no account

A webserver route is the entire backend: the report is in the query string, so
the **access log is the store**. No database, no service, nothing to compromise
beyond the webserver you already run.

```caddyfile
report.example.chat {
	header {
		Content-Type "text/plain; charset=utf-8"
		X-Content-Type-Options nosniff
		Referrer-Policy no-referrer
		-Server
	}
	@get method GET HEAD
	handle @get {
		respond "Thanks — your report was received." 200
	}
	respond 405
	log {
		output file /var/log/caddy/crash.log {
			roll_size 10MiB   # bounds the disk cost of a flood: one live file + 3 rolled
			roll_keep 3
		}
		format filter {
			fields {
				# you asked for the error, not for who hit it. BOTH ip fields:
				# caddy logs remote_ip AND client_ip, so deleting one leaves the
				# address in the log while looking like it doesn't
				request>remote_ip delete
				request>client_ip delete
				request>remote_port delete
				request>headers delete
			}
		}
	}
}
```

On NixOS that body goes in
`services.caddy.virtualHosts."report.example.chat".extraConfig`; the module
already creates `/var/log/caddy` owned by caddy, so no tmpfiles rule. If your
nixpkgs revision also injects a per-vhost `log`, name yours (`log crash { … }`)
— Caddy ≥ 2.9 requires named loggers when a site has more than one. Run
`caddy validate` before switching.

Reports arrive as ordinary access-log lines; `jq` over `crash.log` reads them.

### What keeps it safe to leave open

- **Never echo the query back.** A `respond` that included the report would
  turn your own origin into an attacker-controlled page.
- **Read the log with care.** A hostile "error message" can contain terminal
  escape sequences, so `jq` (not `jq -r`) or `cat -v` when you page through it.
- **Rotation is the real limit.** `roll_size` × `roll_keep` bounds what a flood
  can cost you by construction. Rate limiting needs a plugin build and isn't
  worth it up front.
- **No IP in the log**, per the filter above — which is why the "needs no
  account" wording never claims to be *anonymous*: like any web request, it
  still reaches your server carrying an address, whatever you then do with it.

### One sink serves every instance

Prod, a staging slot and every PR preview can point at the same URL: the report
names its own origin in the body. Don't try to read that from the request
instead — the link is `rel="noreferrer"` and the filter above drops request
headers, so there is neither a `Referer` nor an `Origin` to go on.

**Nothing here needs CORS.** The button is a *link*, so following it is an
ordinary top-level navigation, not a `fetch()` — no preflight, no
`Access-Control-Allow-Origin`, no extra `connect-src` in the app's CSP. That
holds whatever domain the app itself is served from, which is what makes one
sink workable across deployments.

## What is never done

Sending is always a user action on a report shown in full first. Nothing is
transmitted automatically — that would reintroduce the pre-consent transmission
[#174](https://github.com/experintellia/slothfulchat-web/issues/174) closed,
with a far more identifying payload than an analytics bucket.
