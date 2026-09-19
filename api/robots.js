// api/robots.js  (Vercel serverless function, Node runtime)
//
// Calcxi robots.txt tester ka "Live" mode yahan se chalta hai. Browser seedha
// kisi aur site ki robots.txt fetch nahi kar sakta (CORS), isliye ye function
// server side se laata hai aur JSON me wapas deta hai.
//
// Jaan boojh kar limits:
//   - sirf <origin>/robots.txt fetch hota hai, koi aur path nahi (open proxy nahi banta)
//   - sirf http/https, sirf port 80/443
//   - private / loopback / link-local / metadata IPs block (SSRF guard), har
//     redirect hop par dobara check, aur DNS lookup ke waqt hi check hota hai
//     taaki jo IP verify hua wahi connect ho (DNS rebinding se bachav)
//   - Google ki tarah max 5 redirect hops, uske baad 404 jaisa treat
//   - body 500 KiB par cut (Google isse aage ka content ignore karta hai)
//   - ~8.5 s ka total deadline (Vercel hobby limit 10 s)
//
// Env: ALLOWED_ORIGINS  (wahi jo api/reel.js use karta hai, comma separated)

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

const GOOGLE_LIMIT = 500 * 1024;        // 512000 bytes
const READ_LIMIT = GOOGLE_LIMIT + 1;     // ek byte extra padho taaki overflow pata chale
const MAX_HOPS = 5;
const DEADLINE_MS = 8500;
const UA = 'Mozilla/5.0 (compatible; CalcxiRobotsTester/1.0; +https://calcxi.com/robots-txt-tester/)';

// ---------------------------------------------------------------- SSRF guard
function v4ToInt(ip) {
  return ip.split('.').reduce((a, o) => (a * 256) + (+o), 0);
}
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
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(x)) return true;   // hex-mapped v4: block, rare
    const first = parseInt(x.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true;   // ff00::/8 multicast
    if (first === 0x2001 && parseInt(x.split(':')[1] || '0', 16) === 0x0db8) return true; // docs
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
        const e = new Error('Address not allowed'); e.code = 'BLOCKED_ADDRESS';
        return cb(e);
      }
      if (options && options.all) return cb(null, ok);
      cb(null, ok[0].address, ok[0].family);
    });
  };
}

// ---------------------------------------------------------------- input
export function normaliseInput(raw, anyPort = false) {
  let s = String(raw || '').trim();
  if (!s) return { error: 'INVALID_URL', message: 'Enter a domain or URL.' };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch (e) { return { error: 'INVALID_URL', message: 'That does not look like a valid URL.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { error: 'INVALID_URL', message: 'Only http and https are supported.' };
  if (u.username || u.password) return { error: 'INVALID_URL', message: 'URLs with credentials are not accepted.' };
  if (!anyPort && u.port && u.port !== '80' && u.port !== '443') return { error: 'INVALID_URL', message: 'Only ports 80 and 443 are supported.' };
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.') && !net.isIP(host)) return { error: 'INVALID_URL', message: 'Enter a full domain such as example.com.' };
  return { origin: u.protocol + '//' + u.host, robotsUrl: u.protocol + '//' + u.host + '/robots.txt', host };
}

// ---------------------------------------------------------------- one hop
function fetchOnce(target, { allowPrivate, anyPort, timeoutMs }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (e) { const er = new Error('bad redirect'); er.code = 'INVALID_URL'; return reject(er); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { const er = new Error('scheme'); er.code = 'INVALID_URL'; return reject(er); }
    if (!anyPort && u.port && u.port !== '80' && u.port !== '443') { const er = new Error('port'); er.code = 'INVALID_URL'; return reject(er); }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    // IP literal par lookup call hi nahi hota, isliye yahan khud check karo
    if (net.isIP(host) && !allowPrivate && isBlockedIp(host)) {
      const er = new Error('Address not allowed'); er.code = 'BLOCKED_ADDRESS'; return reject(er);
    }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET',
      lookup: makeLookup(allowPrivate),
      agent: false,                      // har request naya socket: purana (verified) socket reuse na ho
      headers: { 'User-Agent': UA, 'Accept': 'text/plain,*/*;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' },
      timeout: timeoutMs
    }, res => {
      const status = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ status, statusText: res.statusMessage, location: new URL(res.headers.location, u).toString(), headers: res.headers });
      }
      let stream = res;
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      const chunks = []; let size = 0; let over = false; let done = false;
      const finish = () => {
        if (done) return; done = true;
        const buf = Buffer.concat(chunks);
        resolve({ status, statusText: res.statusMessage, headers: res.headers, body: buf.subarray(0, GOOGLE_LIMIT), overLimit: over || buf.length > GOOGLE_LIMIT, bytesRead: buf.length });
      };
      stream.on('data', c => {
        if (over) return;
        chunks.push(c); size += c.length;
        if (size >= READ_LIMIT) { over = true; finish(); req.destroy(); }
      });
      stream.on('end', finish);
      stream.on('error', e => { if (!done) { done = true; e.code = e.code || 'NETWORK'; reject(e); } });
    });
    req.on('timeout', () => { const e = new Error('timeout'); e.code = 'TIMEOUT'; req.destroy(e); });
    req.on('error', e => reject(e));
    req.end();
  });
}

// ---------------------------------------------------------------- full fetch
// allowPrivate / anyPort sirf local tests ke liye hain; handler inhe kabhi pass nahi karta
export async function fetchRobots(input, { allowPrivate = false, anyPort = false } = {}) {
  const n = normaliseInput(input, anyPort);
  if (n.error) return { ok: false, code: n.error, message: n.message };
  const started = Date.now();
  const hops = [];
  let url = n.robotsUrl;
  try {
    for (let i = 0; i <= MAX_HOPS; i++) {
      const left = DEADLINE_MS - (Date.now() - started);
      if (left < 500) { const e = new Error('timeout'); e.code = 'TIMEOUT'; throw e; }
      const r = await fetchOnce(url, { allowPrivate, anyPort, timeoutMs: Math.min(6000, left) });
      hops.push({ url, status: r.status });
      if (r.location) {
        if (i === MAX_HOPS) {
          return result(n, url, hops, { status: r.status, statusText: 'Too many redirects', headers: {} }, started, 'too_many_redirects');
        }
        url = r.location; continue;
      }
      return result(n, url, hops, r, started, null);
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
    return { ok: false, code, message: msg, robotsUrl: n.robotsUrl, hops, elapsedMs: Date.now() - started,
      // Google DNS/network errors ko server error maanta hai
      interpretation: (code === 'DNS' || code === 'TIMEOUT' || code === 'NETWORK') ? 'full_disallow' : null };
  }
}

function result(n, finalUrl, hops, r, started, special) {
  let interpretation;
  const s = r.status;
  if (special === 'too_many_redirects') interpretation = 'full_allow';
  else if (s >= 200 && s < 300) interpretation = 'parse';
  else if (s === 429) interpretation = 'full_disallow';
  else if (s >= 400 && s < 500) interpretation = 'full_allow';
  else if (s >= 500) interpretation = 'full_disallow';
  else interpretation = 'full_allow';
  const body = interpretation === 'parse' && r.body ? r.body : Buffer.alloc(0);
  return {
    ok: true,
    input: n.origin,
    robotsUrl: n.robotsUrl,
    finalUrl,
    status: s,
    statusText: special === 'too_many_redirects' ? 'Too many redirects' : (r.statusText || ''),
    redirects: hops.length - 1,
    hops,
    contentType: (r.headers && r.headers['content-type']) || null,
    bytes: r.bytesRead || 0,
    overLimit: !!r.overLimit,
    bodyBase64: body.toString('base64'),
    interpretation,
    fetchedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started
  };
}

// ---------------------------------------------------------------- CORS
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

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
  const out = await fetchRobots(q);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (out.ok) {
    // 5 minute edge cache: same site baar baar test ho to function dobara nahi chalta
    res.setHeader('Cache-Control', 'public, s-maxage=300, max-age=0');
    res.statusCode = 200;
  } else {
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = out.code === 'INVALID_URL' || out.code === 'BLOCKED_ADDRESS' ? 400 : 200;
  }
  res.end(JSON.stringify(out));
}
