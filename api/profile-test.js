// ============================================================
//  PROFILE PROBE v2  —  api/profile-test.js
//
//  v1 me MERI GALTI thi. Usne sirf purane GraphQL field naam
//  dhoondhe the:
//      edge_followed_by
//      edge_owner_to_timeline_media
//  Par Aayush ke browser ko jo HTML mila usme naam `follower_count`
//  hai — naya shape. Isliye v1 ne "data nahi hai" bol diya jabki
//  data ho bhi sakta tha.
//
//  v2 kisi ek naam par bharosa nahi karta. Wo:
//    1. Dono shapes ke SAARE markers dhoondhta hai
//    2. Jo mile uska aas paas ka tukda wapas bhejta hai, taki hum
//       apni aankh se dekh sakein ki page me kya hai
//    3. Number nikaalne ki koshish har shape se karta hai
//    4. Profile page ko cookies ke SAATH bhi maangta hai, kyunki
//       browser ke paas hamesha csrftoken/mid/ig_did hote hain aur
//       v1 ne bina cookie ke maanga tha
//
//  Deploy: repo me api/profile-test.js par (v1 ko overwrite kar do)
//  Chalao : /api/profile-test?u=natgeo
//  Kaam khatam hote hi ISE DELETE karna.
// ============================================================

const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SESSIONID = process.env.IG_SESSIONID || '';
const TIMEOUT = 8000;

/* Har wo marker jo profile data ke hone ka ishara deta hai.
   Dono shapes, aur route ka naam bhi — kyunki
   PolarisLoggedOutDesktopWWWProfileRoute ka matlab hai ki Instagram
   ne ASLI logged-out profile route serve kiya, koi aam shell nahi. */
const MARKERS = [
  'follower_count',
  'edge_followed_by',
  'edge_owner_to_timeline_media',
  'xdt_api__v1__feed__user_timeline_graphql_connection',
  'PolarisProfilePageContent',
  'LoggedOutDesktopWWWProfileRoute',
  'profile_pic_url',
  'biography',
  'is_private',
  'media_count',
];

/** Marker ke aas paas ka tukda — apni aankh se dekhne ke liye */
function peek(html, needle, pad = 90) {
  const i = html.indexOf(needle);
  if (i === -1) return null;
  return html.slice(Math.max(0, i - 20), Math.min(html.length, i + needle.length + pad));
}

/** Follower count har shape se nikaalne ki koshish */
function grabFollowers(html) {
  let m;
  m = html.match(/"follower_count"\s*:\s*(\d+)/);
  if (m) return { value: Number(m[1]), via: 'follower_count' };
  m = html.match(/"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/);
  if (m) return { value: Number(m[1]), via: 'edge_followed_by' };
  m = html.match(/title="([\d,]{4,})"[^>]*>\s*[\d.]+[KMB]?\s*<\/span>/);
  if (m) return { value: Number(m[1].replace(/,/g, '')), via: 'title attribute' };
  m = html.match(/content="([\d.,]+[KMB]?) Followers/i);
  if (m) return { value: m[1], via: 'og:description' };
  return null;
}

/** Posts ke likes/comments kis bhi shape me — engagement rate ke liye ye zaroori hai */
function grabPostCounts(html) {
  const likeKeys = [
    /"edge_liked_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/g,
    /"edge_media_preview_like"\s*:\s*\{\s*"count"\s*:\s*(\d+)/g,
    /"like_count"\s*:\s*(\d+)/g,
  ];
  const commentKeys = [
    /"edge_media_to_comment"\s*:\s*\{\s*"count"\s*:\s*(\d+)/g,
    /"comment_count"\s*:\s*(\d+)/g,
  ];
  const count = (list) => {
    for (const re of list) {
      const m = html.match(re);
      if (m && m.length) return { n: m.length, via: String(re).slice(0, 40), first: m.slice(0, 3) };
    }
    return { n: 0, via: null, first: [] };
  };
  return { likes: count(likeKeys), comments: count(commentKeys) };
}

async function guestJar() {
  const res = await fetch('https://www.instagram.com/', {
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { 'User-Agent': UA_WEB, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  const jar = {};
  for (const c of res.headers.getSetCookie?.() || []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return jar;
}
const cookieStr = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

/** Profile page maango. cookieHeader null ho to bilkul cookie ke bina. */
async function fetchProfilePage(u, cookieHeader) {
  const headers = {
    'User-Agent': UA_WEB,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  const res = await fetch(`https://www.instagram.com/${encodeURIComponent(u)}/`, {
    signal: AbortSignal.timeout(TIMEOUT),
    redirect: 'follow',
    headers,
  });
  const html = await res.text();

  const found = {};
  for (const mk of MARKERS) found[mk] = html.includes(mk);

  const followers = grabFollowers(html);
  const posts = grabPostCounts(html);

  return {
    status: res.status,
    htmlLength: html.length,
    markers: found,
    followers,
    likeCountsFound: posts.likes.n,
    commentCountsFound: posts.comments.n,
    likeSample: posts.likes.first,
    // Ye tukde sabse kaam ke hain: inhe padh kar pata chalega ki page
    // me sach me kya aaya, kisi flag par bharosa nahi karna padega
    peekFollower: peek(html, 'follower_count') || peek(html, 'edge_followed_by'),
    peekRoute: peek(html, 'LoggedOutDesktopWWWProfileRoute', 40),
    looksLikeShell: html.length < 600000 && !followers,
    // engagement rate banane ke liye followers AUR kai posts ke likes, dono chahiye
    usable: Boolean(followers) && posts.likes.n >= 3,
  };
}

// ---------------------------------------------------------------- handler
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const u = String(req.query.u || req.query.username || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(u)) {
    return res.status(400).json({ error: 'Pass a username, for example /api/profile-test?u=natgeo' });
  }

  const startedAt = Date.now();
  const attempts = [];
  let jar = null;

  // --- A: bilkul cookie ke bina (v1 me yahi tha)
  try {
    attempts.push({ tier: 'page-nocookie', ...(await fetchProfilePage(u, null)) });
  } catch (e) {
    attempts.push({ tier: 'page-nocookie', error: `${e.name}: ${e.message}` });
  }

  // --- B: guest cookies ke saath. Browser ke paas hamesha ye hote hain,
  //        aur v1 ne ye combination try hi nahi kiya tha.
  try {
    jar = await guestJar();
    attempts.push({
      tier: 'page-guestcookies',
      cookies: Object.keys(jar),
      ...(await fetchProfilePage(u, cookieStr(jar))),
    });
  } catch (e) {
    attempts.push({ tier: 'page-guestcookies', error: `${e.name}: ${e.message}` });
  }

  // --- C: sessionid ke saath, agar set ho
  if (SESSIONID) {
    try {
      const c = { ...(jar || {}), sessionid: SESSIONID };
      attempts.push({ tier: 'page-session', ...(await fetchProfilePage(u, cookieStr(c))) });
    } catch (e) {
      attempts.push({ tier: 'page-session', error: `${e.name}: ${e.message}` });
    }
  }

  const winner = attempts.find((a) => a.usable) || null;
  const anyFollowers = attempts.find((a) => a.followers) || null;

  return res.status(200).json({
    verdict: winner
      ? `BUILDABLE via ${winner.tier}`
      : anyFollowers
        ? `PARTIAL: followers found via ${anyFollowers.tier}, but post counts are missing`
        : 'NOT BUILDABLE from this server right now',
    workingTier: winner ? winner.tier : null,
    followers: anyFollowers ? anyFollowers.followers : null,
    username: u,
    hadSessionId: Boolean(SESSIONID),
    tookMs: Date.now() - startedAt,
    attempts,
  });
}
