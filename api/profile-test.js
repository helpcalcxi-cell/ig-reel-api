// ============================================================
//  PROBE v4  —  api/profile-test.js
//
//  v2 ne jaldi haar maan li thi. Uski do kamiyan thin:
//
//  1. Cookie bootstrap kamzor tha. Usne sirf csrftoken aur mid
//     uthaayi. Browser ke paas `datr` aur `ig_did` BHI hote hain,
//     aur wahi Instagram ke device identity cookies hain jinka
//     logged-out gating me sabse bada role hota hai.
//
//  2. Usne sirf profile page HTML try kiya. Browser ke DevTools me
//     saaf dikhta hai ki data GraphQL aur doosre endpoints se bhi
//     aata hai. Wo raaste chhue hi nahi gaye.
//
//  Ek baat jo yaad rakhni hai: POST page Vercel se theek chalta hai.
//  Agar Instagram is IP ko bot maanta, to wo bhi fail hota. Yani
//  masla poore IP ka nahi, sirf is ek route ki policy ka hai.
//
//  Paanch raaste, poore browser jaise headers ke saath:
//    A  profile page   (poori cookies)
//    B  ?__a=1&__d=dis (purana JSON variant)
//    C  web_profile_info  www.instagram.com par
//    D  web_profile_info  i.instagram.com par (alag host)
//    E  GraphQL POST      (doc_id tum DevTools se doge)
//
//  Chalao : /api/profile-test?u=natgeo
//  GraphQL bhi try karne ke liye:
//           /api/profile-test?u=natgeo&doc_id=<DevTools wala number>
// ============================================================

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const IG_APP_ID = '936619743392459';
const ASBD_ID = '129477';
const SESSIONID = process.env.IG_SESSIONID || '';
const T = 8000;

/* Browser jo bhejta hai, lagbhag wahi. v2 me client hints adhoore the. */
function browserHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-ch-ua-platform-version': '"15.0.0"',
    'sec-ch-ua-full-version-list':
      '"Chromium";v="131.0.6778.86", "Not_A Brand";v="24.0.0.0", "Google Chrome";v="131.0.6778.86"',
    ...extra,
  };
}

/* ---- follower count har shape se ---- */
const FOLLOWER_RE = [
  ['follower_count', /"follower_count"\s*:\s*(\d+)/],
  ['edge_followed_by', /"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/],
  ['followers_count', /"followers_count"\s*:\s*(\d+)/],
];
function grabFollowers(text) {
  for (const [name, re] of FOLLOWER_RE) {
    const m = text.match(re);
    if (m) return { field: name, value: Number(m[1]) };
  }
  return null;
}
function countMatches(text, re) {
  const all = text.match(new RegExp(re.source, 'g'));
  return all ? all.length : 0;
}
function grabPosts(text) {
  return {
    likes: Math.max(
      countMatches(text, /"like_count"\s*:\s*\d+/),
      countMatches(text, /"edge_liked_by"\s*:\s*\{\s*"count"/)
    ),
    comments: Math.max(
      countMatches(text, /"comment_count"\s*:\s*\d+/),
      countMatches(text, /"edge_media_to_comment"\s*:\s*\{\s*"count"/)
    ),
  };
}
function peek(text, needle, pad = 110) {
  const i = text.indexOf(needle);
  if (i === -1) return null;
  return text.slice(Math.max(0, i - 25), Math.min(text.length, i + needle.length + pad));
}
function verdictFor(text) {
  const f = grabFollowers(text);
  const p = grabPosts(text);
  return { followers: f, posts: p, usable: Boolean(f) && p.likes >= 3 };
}

/* ---------------------------------------------------------- cookies
   v2 ne sirf ek homepage GET kiya tha aur do cookies mili thin.
   Browser ko `datr` aur `ig_did` bhi milte hain, isliye do jagah se
   uthate hain aur jo mile sab jodte hain. */
async function bigJar() {
  const jar = {};
  const grab = async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(T), headers: browserHeaders({
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none',
      }) });
      for (const c of r.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
      }
      // kabhi kabhi ig_did sirf HTML ke andar milta hai
      const html = await r.text();
      if (!jar.ig_did) {
        const m = html.match(/"device_id"\s*:\s*"([A-F0-9-]{36})"/i);
        if (m) jar.ig_did = m[1];
      }
      if (!jar.csrftoken) {
        const m = html.match(/"csrf_token"\s*:\s*"([^"]+)"/);
        if (m) jar.csrftoken = m[1];
      }
    } catch { /* ek jagah fail ho to doosri se chal jayega */ }
  };
  await grab('https://www.instagram.com/');
  if (!jar.datr || !jar.ig_did) await grab('https://www.instagram.com/accounts/login/');
  return jar;
}
const cookieStr = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

/* ---------------------------------------------------------- tiers */
async function tierPage(u, jar, qs = '') {
  const r = await fetch(`https://www.instagram.com/${encodeURIComponent(u)}/${qs}`, {
    signal: AbortSignal.timeout(T),
    redirect: 'follow',
    headers: browserHeaders({
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      ...(jar ? { Cookie: cookieStr(jar) } : {}),
    }),
  });
  const text = await r.text();
  return { status: r.status, length: text.length, ...verdictFor(text), peekF: peek(text, 'follower_count') };
}

async function tierWebApi(host, u, jar) {
  const r = await fetch(
    `https://${host}/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`,
    {
      signal: AbortSignal.timeout(T),
      headers: browserHeaders({
        Accept: '*/*',
        'x-ig-app-id': IG_APP_ID,
        'x-asbd-id': ASBD_ID,
        'x-ig-www-claim': '0',
        'x-requested-with': 'XMLHttpRequest',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        Referer: `https://www.instagram.com/${u}/`,
        ...(jar?.csrftoken ? { 'x-csrftoken': jar.csrftoken } : {}),
        ...(jar ? { Cookie: cookieStr(jar) } : {}),
      }),
    }
  );
  const text = await r.text();
  let igMessage = null;
  try { igMessage = JSON.parse(text).message || null; } catch {}
  return { status: r.status, length: text.length, igMessage, ...verdictFor(text), peekF: peek(text, 'follower_count') };
}

async function tierGraphql(u, jar, docId) {
  const body = new URLSearchParams({
    doc_id: docId,
    variables: JSON.stringify({ username: u, is_prefetch: false, render_surface: 'PROFILE' }),
    server_timestamps: 'true',
  });
  const r = await fetch('https://www.instagram.com/api/graphql', {
    method: 'POST',
    signal: AbortSignal.timeout(T),
    headers: browserHeaders({
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-ig-app-id': IG_APP_ID,
      'x-asbd-id': ASBD_ID,
      'x-fb-friendly-name': 'PolarisProfilePageContentQuery',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      Origin: 'https://www.instagram.com',
      Referer: `https://www.instagram.com/${u}/`,
      ...(jar?.csrftoken ? { 'x-csrftoken': jar.csrftoken } : {}),
      ...(jar ? { Cookie: cookieStr(jar) } : {}),
    }),
    body,
  });
  const text = await r.text();
  return { status: r.status, length: text.length, ...verdictFor(text), sample: text.slice(0, 220) };
}

/* ---------------------------------------------------------- handler */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const u = String(req.query.u || req.query.username || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(u)) {
    return res.status(400).json({ error: 'Pass a username, for example /api/profile-test?u=natgeo' });
  }
  const docId = String(req.query.doc_id || '').replace(/\D/g, '');

  const startedAt = Date.now();
  const attempts = [];

  const jar = await bigJar();
  const jarKeys = Object.keys(jar);
  const sessionJar = SESSIONID ? { ...jar, sessionid: SESSIONID } : null;

  const run = async (tier, fn) => {
    try { attempts.push({ tier, ...(await fn()) }); }
    catch (e) { attempts.push({ tier, error: `${e.name}: ${e.message}` }); }
  };

  await run('A page+cookies', () => tierPage(u, jar));
  await run('B page ?__a=1', () => tierPage(u, jar, '?__a=1&__d=dis'));
  await run('C webapi www', () => tierWebApi('www.instagram.com', u, jar));
  await run('D webapi i.', () => tierWebApi('i.instagram.com', u, jar));
  if (docId) await run('E graphql', () => tierGraphql(u, jar, docId));
  if (sessionJar) await run('F page+session', () => tierPage(u, sessionJar));

  const winner = attempts.find((a) => a.usable) || null;
  const partial = attempts.find((a) => a.followers) || null;

  return res.status(200).json({
    verdict: winner
      ? `BUILDABLE via ${winner.tier}`
      : partial
        ? `PARTIAL: followers found via ${partial.tier}, post counts missing`
        : 'no tier returned profile data',
    workingTier: winner ? winner.tier : null,
    // Ye line dekhna: v2 me sirf csrftoken aur mid the. Ab datr aur
    // ig_did bhi aaye ya nahi, wo yahan pata chalega.
    cookiesCollected: jarKeys,
    docIdUsed: docId || null,
    username: u,
    tookMs: Date.now() - startedAt,
    attempts,
  });
}
