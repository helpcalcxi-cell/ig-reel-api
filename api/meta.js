// api/meta.js  (Vercel serverless function, Node runtime)
//
// Calcxi SERP Snippet Preview ka "Fetch from URL" yahan se chalta hai. Browser
// dusri site ka HTML CORS ki wajah se nahi padh sakta, isliye ye function page
// laata hai aur sirf meta fields JSON me wapas deta hai (poora HTML kabhi nahi,
// taaki ye open proxy na ban jaye).
//
// Jaan boojh kar limits:
//   - sirf http/https, sirf port 80/443, credentials wale URL reject
//   - private / loopback / link-local / metadata IP block (SSRF guard), har
//     redirect hop par dobara, aur DNS lookup ke waqt hi, taaki verified IP par
//     hi connect ho (DNS rebinding se bachav)
//   - max 5 redirect hops
//   - sirf HTML content type, body 1 MiB par cut, ~8.5 s deadline
//   - response me sirf nikale gaye fields jaate hain
//
// Env: ALLOWED_ORIGINS (comma separated), wahi jo baaki functions use karte hain

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

const READ_LIMIT = 1024 * 1024;
const MAX_HOPS = 5;
const DEADLINE_MS = 8500;
const UA = 'Mozilla/5.0 (compatible; CalcxiSerpPreview/1.0; +https://calcxi.com/serp-snippet-preview/)';

// ---------------------------------------------------------------- SSRF guard
function v4ToInt(ip) { return ip.split('.').reduce((a, o) => (a * 256) + (+o), 0); }
function inV4(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (0xFFFFFFFF << (32 - +bits)) >>> 0;
  return ((v4ToInt(ip) & mask) >>> 0) === ((v4ToInt(base) & mask) >>> 0);
}
const V4_BLOCK = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16',
  '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'
];
export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return V4_BLOCK.some(c => inV4(ip, c));
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/) || x.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(x)) return true;
    const first = parseInt(x.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true;
    if ((first & 0xffc0) === 0xfe80) return true;
    if ((first & 0xff00) === 0xff00) return true;
    if (first === 0x2001 && parseInt(x.split(':')[1] || '0', 16) === 0x0db8) return true;
    return false;
  }
  return true;
}
function makeLookup(allowPrivate) {
  return function guardedLookup(hostname, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    dns.lookup(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      const ok = allowPrivate ? addrs : addrs.filter(a => !isBlockedIp(a.address));
      if (!ok.length || (!allowPrivate && ok.length !== addrs.length)) {
        const e = new Error('Address not allowed'); e.code = 'BLOCKED_ADDRESS'; return cb(e);
      }
      if (options && options.all) return cb(null, ok);
      cb(null, ok[0].address, ok[0].family);
    });
  };
}

// ---------------------------------------------------------------- input
export function normaliseInput(raw, anyPort = false) {
  let s = String(raw || '').trim();
  if (!s) return { error: 'INVALID_URL', message: 'Enter a page URL.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return { error: 'INVALID_URL', message: 'That does not look like a valid URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'INVALID_URL', message: 'Only http and https are supported.' };
  if (u.username || u.password) return { error: 'INVALID_URL', message: 'URLs with credentials are not accepted.' };
  if (!anyPort && u.port && u.port !== '80' && u.port !== '443') return { error: 'INVALID_URL', message: 'Only ports 80 and 443 are supported.' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !net.isIP(host)) return { error: 'INVALID_URL', message: 'Enter a full URL such as example.com/page/.' };
  u.hash = '';
  return { pageUrl: u.toString(), host };
}

// ---------------------------------------------------------------- one hop
function fetchOnce(target, { allowPrivate, anyPort, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (e) { const er = new Error('bad redirect'); er.code = 'INVALID_URL'; return reject(er); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { const er = new Error('scheme'); er.code = 'INVALID_URL'; return reject(er); }
    if (!anyPort && u.port && u.port !== '80' && u.port !== '443') { const er = new Error('port'); er.code = 'INVALID_URL'; return reject(er); }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !allowPrivate && isBlockedIp(host)) {
      const er = new Error('Address not allowed'); er.code = 'BLOCKED_ADDRESS'; return reject(er);
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      lookup: makeLookup(allowPrivate),
      agent: false,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: timeoutMs
    }, res => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ status, statusText: res.statusMessage, location: new URL(res.headers.location, u).toString(), headers: res.headers });
      }
      const ctype = String(res.headers['content-type'] || '').toLowerCase();
      if (ctype && !/html|xml|text\/plain/.test(ctype)) {
        res.resume();
        return resolve({ status, statusText: res.statusMessage, headers: res.headers, body: Buffer.alloc(0), notHtml: true });
      }
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let size = 0; let done = false;
      const finish = () => {
        if (done) return; done = true;
        resolve({ status, statusText: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks).subarray(0, READ_LIMIT) });
      };
      stream.on('data', c => {
        if (done) return;
        chunks.push(c); size += c.length;
        if (size >= READ_LIMIT) { finish(); req.destroy(); }
      });
      stream.on('end', finish);
      stream.on('error', e => { if (!done) { done = true; e.code = e.code || 'NETWORK'; reject(e); } });
    });
    req.on('timeout', () => { const e = new Error('timeout'); e.code = 'TIMEOUT'; req.destroy(e); });
    req.on('error', e => reject(e));
    req.end();
  });
}

// ---------------------------------------------------------------- parsing
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#34': '"' };
function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+|#\d+);/gi, (m, n) => (ENT[n.toLowerCase()] !== undefined ? ENT[n.toLowerCase()] : m));
}
function safeChar(code) {
  if (!code || code < 0 || code > 0x10FFFF) return '';
  try { return String.fromCodePoint(code); } catch (e) { return ''; }
}
function clean(s) { return decode(s).replace(/\s+/g, ' ').trim(); }

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : m[5]);
  return out;
}

export function extract(html, finalUrl) {
  const head = html.slice(0, 600000);
  const out = { title: '', description: '', canonical: '', ogTitle: '', ogDescription: '', ogSiteName: '', robots: '', h1: '', lang: '' };
  const t = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (t) out.title = clean(t[1]);
  const lang = head.match(/<html[^>]*\slang\s*=\s*["']?([a-zA-Z-]+)/i);
  if (lang) out.lang = lang[1];
  const metas = head.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of metas) {
    const a = attrs(tag);
    const name = String(a.name || a.property || a.itemprop || '').toLowerCase();
    const val = clean(a.content || '');
    if (!val) continue;
    if (name === 'description' && !out.description) out.description = val;
    else if (name === 'og:title' && !out.ogTitle) out.ogTitle = val;
    else if (name === 'og:description' && !out.ogDescription) out.ogDescription = val;
    else if (name === 'og:site_name' && !out.ogSiteName) out.ogSiteName = val;
    else if (name === 'robots' && !out.robots) out.robots = val.toLowerCase();
  }
  const links = head.match(/<link\b[^>]*>/gi) || [];
  for (const tag of links) {
    const a = attrs(tag);
    if (String(a.rel || '').toLowerCase().split(/\s+/).includes('canonical') && a.href) {
      try { out.canonical = new URL(decode(a.href), finalUrl).toString(); } catch (e) { out.canonical = decode(a.href); }
      break;
    }
  }
  const h = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h) out.h1 = clean(h[1].replace(/<[^>]+>/g, ' ')).slice(0, 300);
  return out;
}

// ---------------------------------------------------------------- full fetch
export async function fetchMeta(input, { allowPrivate = false, anyPort = false } = {}) {
  const n = normaliseInput(input, anyPort);
  if (n.error) return { ok: false, code: n.error, message: n.message };
  const started = Date.now();
  const hops = [];
  let url = n.pageUrl;
  try {
    for (let i = 0; i <= MAX_HOPS; i++) {
      const left = DEADLINE_MS - (Date.now() - started);
      if (left < 500) { const e = new Error('timeout'); e.code = 'TIMEOUT'; throw e; }
      const r = await fetchOnce(url, { allowPrivate, anyPort, timeoutMs: Math.min(6500, left) });
      hops.push({ url, status: r.status });
      if (r.location) {
        if (i === MAX_HOPS) return { ok: false, code: 'REDIRECTS', message: 'Too many redirects.', hops };
        url = r.location; continue;
      }
      if (r.status >= 400) {
        return { ok: false, code: 'HTTP_' + r.status, status: r.status,
          message: 'The page answered with HTTP ' + r.status + ', so there was nothing to read.', finalUrl: url, hops };
      }
      if (r.notHtml) {
        return { ok: false, code: 'NOT_HTML', message: 'That URL is not an HTML page.', finalUrl: url, hops };
      }
      const html = r.body.toString('utf8');
      const data = extract(html, url);
      return {
        ok: true, input: n.pageUrl, finalUrl: url, status: r.status,
        redirects: hops.length - 1, hops, ...data,
        bytes: r.body.length, truncated: r.body.length >= READ_LIMIT,
        fetchedAt: new Date().toISOString(), elapsedMs: Date.now() - started
      };
    }
  } catch (e) {
    const code = e.code === 'BLOCKED_ADDRESS' ? 'BLOCKED_ADDRESS'
      : e.code === 'TIMEOUT' ? 'TIMEOUT'
      : (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN' || e.code === 'ENODATA') ? 'DNS'
      : e.code === 'INVALID_URL' ? 'INVALID_URL' : 'NETWORK';
    const msg = {
      BLOCKED_ADDRESS: 'That host resolves to a private or reserved address, so it was not fetched.',
      TIMEOUT: 'The server took too long to answer.',
      DNS: 'The domain name could not be resolved.',
      INVALID_URL: 'A redirect pointed somewhere that cannot be followed.',
      NETWORK: 'The connection failed before a response arrived.'
    }[code];
    return { ok: false, code, message: msg, input: n.pageUrl, hops, elapsedMs: Date.now() - started };
  }
}

// ---------------------------------------------------------------- CORS
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
function applyCors(req, res) {
  if (!ALLOWED_ORIGINS.length) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (ALLOWED_ORIGINS.includes(req.headers.origin)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  else res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  if (req.method !== 'GET') { res.statusCode = 405; res.setHeader('Cache-Control', 'no-store'); return res.end(); }
  const q = req.query && req.query.url !== undefined ? req.query.url
    : new URL(req.url, 'http://x').searchParams.get('url');
  const out = await fetchMeta(q);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (out.ok) {
    res.setHeader('Cache-Control', 'public, s-maxage=300, max-age=0');
    res.statusCode = 200;
  } else {
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = out.code === 'INVALID_URL' || out.code === 'BLOCKED_ADDRESS' ? 400 : 200;
  }
  res.end(JSON.stringify(out));
}
