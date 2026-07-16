// Optional link-preview unfurl handler for the ws-tcp bridge (UNFURL=1).
//
//   GET /unfurl?url={http(s) URL}
//     → { url, title, description, isVideo, twitterCard, imageWidth,
//         imageHeight, image (base64|null), imageMime } with permissive CORS
//
// The webapp's composer fetches pages in the browser (CORS-bound), which most
// sites block; this fetches the page + og:image server-side instead. It is a
// *preview fetcher*, not a relay — hence: GET only, http/https only, private/
// loopback/link-local/CGNAT IPs refused (checked inside the socket's own
// lookup, so a rebinding resolver can't swap the address; literal-IP hosts are
// checked separately since they bypass lookup), redirects re-checked per hop,
// size caps, timeout, rate limit. UNFURL_ALLOW_PRIVATE=1 disables the IP guard
// for the test suite only.
//
// ponytail: regex OG parsing — a preview card needs og:*/twitter:*/<title>,
// not an HTML parser.
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { lookup } from 'node:dns';
import { isIP, BlockList } from 'node:net';

const ALLOW_PRIVATE = process.env.UNFURL_ALLOW_PRIVATE === '1';
const MAX_PAGE_BYTES = 1 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const RATE_LIMIT = 30; // requests per client per minute

// SSRF guard: reject loopback / private / link-local / CGNAT targets. Built on
// node:net BlockList rather than a hand-rolled regex because BlockList matches
// IPv4-mapped IPv6 (both ::ffff:127.0.0.1 AND the hex-compressed ::ffff:7f00:1)
// against the IPv4 rules — the previous regex only caught the dotted form, so
// `[::ffff:a9fe:a9fe]` reached 169.254.169.254 (cloud metadata) unblocked.
const PRIVATE_IPS = new BlockList();
PRIVATE_IPS.addSubnet('0.0.0.0', 8, 'ipv4');
PRIVATE_IPS.addSubnet('10.0.0.0', 8, 'ipv4');
PRIVATE_IPS.addSubnet('100.64.0.0', 10, 'ipv4'); // CGNAT
PRIVATE_IPS.addSubnet('127.0.0.0', 8, 'ipv4');
PRIVATE_IPS.addSubnet('169.254.0.0', 16, 'ipv4'); // link-local incl. cloud metadata
PRIVATE_IPS.addSubnet('172.16.0.0', 12, 'ipv4');
PRIVATE_IPS.addSubnet('192.168.0.0', 16, 'ipv4');
PRIVATE_IPS.addAddress('::', 'ipv6');
PRIVATE_IPS.addAddress('::1', 'ipv6');
PRIVATE_IPS.addSubnet('fc00::', 7, 'ipv6'); // unique-local
PRIVATE_IPS.addSubnet('fe80::', 10, 'ipv6'); // link-local
const isPrivateIp = (ip) => {
  const fam = isIP(ip);
  return fam !== 0 && PRIVATE_IPS.check(ip, fam === 4 ? 'ipv4' : 'ipv6');
};

// *.localhost is loopback by spec (RFC 6761), never sent to the resolver.
const guardedLookup = (hostname, options, callback) => {
  const done = (err, addrs) => {
    if (err) return callback(err);
    if (!ALLOW_PRIVATE && addrs.some((a) => isPrivateIp(a.address)))
      return callback(new Error('resolves to a private address'));
    if (options?.all) return callback(null, addrs);
    callback(null, addrs[0].address, addrs[0].family);
  };
  if (hostname === 'localhost' || hostname.endsWith('.localhost'))
    return done(null, [{ address: '127.0.0.1', family: 4 }]);
  lookup(hostname, { all: true }, done);
};

/**
 * GET `url` with the guarded lookup, redirect + size + timeout limits.
 * `headOnly` (for the HTML page): stop reading at `</head>` — the OG/twitter/
 * title tags all live there, so there's no need to pull a multi-MB page body
 * (YouTube etc.) — and if the cap is reached first, truncate and parse what we
 * have rather than failing. For images `headOnly` is false: a truncated image
 * is useless, so hitting the cap is an error.
 */
const guardedGet = (url, maxBytes, headOnly = false, redirectsLeft = MAX_REDIRECTS) =>
  new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      return reject(new Error('only http/https URLs are supported'));
    const literal = parsed.hostname.replace(/^\[|\]$/g, ''); // IPs skip lookup
    if (isIP(literal) && !ALLOW_PRIVATE && isPrivateIp(literal))
      return reject(new Error('resolves to a private address'));
    const req = (parsed.protocol === 'https:' ? httpsGet : httpGet)(
      parsed,
      { lookup: guardedLookup, timeout: FETCH_TIMEOUT_MS, headers: { accept: '*/*' } },
      (res) => {
        const { statusCode = 0, headers } = res;
        let settled = false;
        const chunks = [];
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve({
            body: Buffer.concat(chunks),
            contentType: headers['content-type'] ?? null,
            finalUrl: parsed.toString(),
          });
        };
        const fail = (err) => {
          if (settled) return;
          settled = true;
          reject(err);
        };
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return fail(new Error('too many redirects'));
          // the redirect target goes through the same guards (new lookup)
          return resolve(
            guardedGet(new URL(headers.location, parsed).toString(), maxBytes, headOnly, redirectsLeft - 1)
          );
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          return fail(new Error(`upstream returned ${statusCode}`));
        }
        let size = 0;
        let carry = ''; // small tail so `</head>` isn't missed across chunks
        res.on('data', (c) => {
          chunks.push(c);
          size += c.length;
          if (headOnly) {
            const hay = carry + c.toString('latin1').toLowerCase();
            if (hay.includes('</head>')) {
              req.destroy();
              return finish();
            }
            carry = hay.slice(-7);
            if (size >= maxBytes) {
              // Never saw </head> within the cap — parse what we have anyway.
              req.destroy();
              return finish();
            }
          } else if (size > maxBytes) {
            req.destroy();
            return fail(new Error('response too large'));
          }
        });
        res.on('end', finish);
        res.on('error', fail);
      }
    );
    req.on('timeout', () => req.destroy(new Error('fetch timed out')));
    req.on('error', reject);
  });

const decodeEntities = (s) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const parseMeta = (html) => {
  const meta = new Map();
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const key = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (key && content && !meta.has(key)) meta.set(key, decodeEntities(content.trim()));
  }
  const title = html.match(/<title[^>]*>([^<]*)/i)?.[1];
  if (title && !meta.has('title')) meta.set('title', decodeEntities(title.trim()));
  return (keys) => keys.map((k) => meta.get(k)).find(Boolean) ?? null;
};
const toInt = (v) => (Number.isFinite(parseInt(v ?? '', 10)) ? parseInt(v, 10) : null);

const hits = new Map(); // "ip|minute" -> count
const rateLimited = (ip) => {
  const key = `${ip}|${Math.floor(Date.now() / 60_000)}`;
  if (hits.size > 10_000) hits.clear();
  const n = (hits.get(key) ?? 0) + 1;
  hits.set(key, n);
  return n > RATE_LIMIT;
};

/** node:http request handler for GET /unfurl?url=… */
export async function unfurlHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const send = (code, obj) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  if (req.method !== 'GET') return send(405, { error: 'GET only' });
  if (rateLimited(req.socket.remoteAddress ?? '?')) return send(429, { error: 'rate limited' });
  const target = new URL(req.url, 'http://unfurl').searchParams.get('url');
  if (!target) return send(400, { error: 'missing ?url=' });

  try {
    const page = await guardedGet(target, MAX_PAGE_BYTES, true);
    const first = parseMeta(page.body.toString('utf8'));
    const title = first(['og:title', 'twitter:title', 'title']);
    if (!title) return send(404, { error: 'page has no previewable metadata' });

    const imageUrl = first(['og:image:secure_url', 'og:image', 'twitter:image']);
    let image = null;
    let imageMime = null;
    if (imageUrl) {
      try {
        const img = await guardedGet(new URL(imageUrl, page.finalUrl).toString(), MAX_IMAGE_BYTES);
        if (img.contentType?.startsWith('image/')) {
          image = img.body.toString('base64');
          imageMime = img.contentType.split(';')[0];
        }
      } catch (err) {
        console.warn(`unfurl: image fetch failed for ${target}: ${err.message}`);
      }
    }
    send(200, {
      url: page.finalUrl,
      title,
      description: first(['og:description', 'twitter:description', 'description']),
      isVideo: (first(['og:type']) ?? '').toLowerCase().startsWith('video') ||
        first(['og:video', 'og:video:url', 'twitter:player']) != null,
      twitterCard: first(['twitter:card']),
      imageWidth: toInt(first(['og:image:width'])),
      imageHeight: toInt(first(['og:image:height'])),
      image,
      imageMime,
    });
    console.log(`unfurled ${target}`);
  } catch (err) {
    console.warn(`unfurl failed for ${target}: ${err.message}`);
    send(502, { error: err.message });
  }
}
