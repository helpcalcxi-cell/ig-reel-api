// ============================================================
//  PROFILE PROBE  —  api/profile-test.js
//
//  Ye production endpoint NAHI hai. Iska ek hi kaam hai: ye pata
//  karna ki Vercel ke IP se Instagram ka PUBLIC PROFILE padha ja
//  sakta hai ya nahi.
//
//  Zaroorat kyun padi: reel.js ek POST fetch karti hai shortcode se.
//  Engagement rate calculator ko PROFILE chahiye — follower count aur
//  pichhli kuch posts ke likes/comments. Wo bilkul alag darwaza hai,
//  aur Instagram profile pages ko post pages se zyada sakhti se band
//  karta hai. Isliye bada page banane se PEHLE ye jaanna zaroori hai.
//
//  Chaar raaste try karta hai aur batata hai kaunsa chala:
//    A  profile page HTML     (bina cookie — sabse saaf, sabse sasta)
//    B  web_profile_info API  (bina cookie, sirf x-ig-app-id header)
//    C  web_profile_info API  (guest cookies ke saath)
//    D  web_profile_info API  (sessionid ke saath, agar set ho)
//
//  Deploy: is file ko repo me api/profile-test.js par rakho.
//  Chalao : /api/profile-test?u=natgeo
//
//  Kaam ho jane ke baad ISE HATA DENA. Ye khula hua diagnostic hai
//  aur production me iski koi jagah nahi.
// ============================================================

const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const IG_APP_ID = '936619743392459';
const SESSIONID = process.env.IG_SESSIONID || '';
const TIMEOUT = 7000;

/** HTML me bikhre hue JSON blobs — wahi tareeka jo reel-page tier me chala tha */
function* jsonBlobs(html) {
  const re = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { yield JSON.parse(m[1]); } catch { /* har blob JSON nahi hota */ }
  }
}

/** Kisi bhi gehraai me pada hua user object dhoondho */
function findUser(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 14) return null;
  if (node.username && (node.edge_followed_by || node.follower_count != null)) return node;
  for (const k of Object.keys(node)) {
    const found = findUser(node[k], depth + 1);
    if (found) return found;
  }
  return null;
}

/** Alag alag shape se posts nikaalne ki koshish */
function postsFrom(user) {
  if (!user) return [];
  const edges =
    user.edge_owner_to_timeline_media?.edges ||
    user.edge_felix_video_timeline?.edges || [];
  return edges.map((e) => {
    const n = e.node || e;
    return {
      code: n.shortcode || n.code || null,
      isVideo: Boolean(n.is_video),
      likes: n.edge_liked_by?.count ?? n.edge_media_preview_like?.count ?? n.like_count ?? null,
      comments: n.edge_media_to_comment?.count ?? n.comment_count ?? null,
      plays: n.video_play_count ?? n.video_view_count ?? n.play_count ?? null,
      takenAt: n.taken_at_timestamp || n.taken_at || null,
    };
  });
}

function followersOf(user) {
  if (!user) return null;
  return user.edge_followed_by?.count ?? user.follower_count ?? null;
}

function summarise(user) {
  const posts = postsFrom(user);
  const withLikes = posts.filter((p) => p.likes != null).length;
  return {
    username: user?.username || null,
    fullName: user?.full_name || null,
    isPrivate: user?.is_private ?? null,
    followers: followersOf(user),
    postsTotal: user?.edge_owner_to_timeline_media?.count ?? user?.media_count ?? null,
    postsReturned: posts.length,
    postsWithLikeCounts: withLikes,
    // Yahi asli sawaal hai: bina likes/comments ke calculator ban hi nahi sakta
    usable: Boolean(followersOf(user)) && withLikes >= 3,
    sample: posts.slice(0, 3),
  };
}

// ---------------------------------------------------------------- cookies
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

// ---------------------------------------------------------------- tiers
async function tierProfilePage(u) {
  const res = await fetch(`https://www.instagram.com/${encodeURIComponent(u)}/`, {
    signal: AbortSignal.timeout(TIMEOUT),
    redirect: 'follow',
    headers: {
      'User-Agent': UA_WEB,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      // Jaan-bujh kar koi cookie nahi. Yahi tier reel.js me sabse acha chala tha.
    },
  });
  const html = await res.text();
  const facts = {
    status: res.status,
    htmlLength: html.length,
    mentionsLogin: /loginForm|"login_required"|Log in to Instagram/i.test(html),
    hasEdgeFollowed: html.includes('edge_followed_by'),
    hasTimeline: html.includes('edge_owner_to_timeline_media'),
  };
  if (!res.ok) return { ok: false, reason: `profile page HTTP ${res.status}`, ...facts };

  let user = null;
  for (const blob of jsonBlobs(html)) {
    user = findUser(blob);
    if (user) break;
  }
  if (!user) {
    return {
      ok: false,
      reason: facts.hasEdgeFollowed
        ? 'profile data is in the page but could not be parsed'
        : 'profile page came back without profile data, so Instagram treated this server as logged out',
      ...facts,
    };
  }
  const s = summarise(user);
  return { ok: s.usable, ...facts, ...s };
}

async function tierWebApi(u, jar, withSession) {
  const headers = {
    'User-Agent': UA_WEB,
    'Accept-Language': 'en-US,en;q=0.9',
    'x-ig-app-id': IG_APP_ID,
    'x-requested-with': 'XMLHttpRequest',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
  };
  if (jar) {
    if (jar.csrftoken) headers['x-csrftoken'] = jar.csrftoken;
    const c = { ...jar };
    if (withSession && SESSIONID) c.sessionid = SESSIONID;
    headers.Cookie = cookieStr(c);
  } else if (withSession && SESSIONID) {
    headers.Cookie = `sessionid=${SESSIONID}`;
  }

  const res = await fetch(
    `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`.replace('i.instagram.com', 'www.instagram.com'),
    { signal: AbortSignal.timeout(TIMEOUT), headers }
  );
  const text = await res.text();
  const facts = { status: res.status, bodyLength: text.length };
  if (!res.ok) {
    let msg = null;
    try { msg = JSON.parse(text).message || null; } catch {}
    return { ok: false, reason: `web api HTTP ${res.status}`, igMessage: msg, ...facts };
  }
  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, reason: 'web api returned HTML instead of JSON', ...facts }; }

  const user = json?.data?.user || findUser(json);
  if (!user) return { ok: false, reason: 'web api response had no user object', ...facts };
  const s = summarise(user);
  return { ok: s.usable, ...facts, ...s };
}

// ---------------------------------------------------------------- handler
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const u = String(req.query.u || req.query.username || '').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(u)) {
    return res.status(400).json({
      error: 'Pass a username, for example /api/profile-test?u=natgeo',
    });
  }

  const startedAt = Date.now();
  const attempts = [];
  let jar = null;

  // --- A: profile page, bina cookie
  try {
    const r = await tierProfilePage(u);
    attempts.push({ tier: 'profile-page', ...r });
  } catch (e) {
    attempts.push({ tier: 'profile-page', ok: false, reason: `${e.name}: ${e.message}` });
  }

  // --- B: web api, bina cookie
  try {
    const r = await tierWebApi(u, null, false);
    attempts.push({ tier: 'web-api-nocookie', ...r });
  } catch (e) {
    attempts.push({ tier: 'web-api-nocookie', ok: false, reason: `${e.name}: ${e.message}` });
  }

  // --- C: web api, guest cookies ke saath
  try {
    jar = await guestJar();
    const r = await tierWebApi(u, jar, false);
    attempts.push({ tier: 'web-api-guest', cookies: Object.keys(jar), ...r });
  } catch (e) {
    attempts.push({ tier: 'web-api-guest', ok: false, reason: `${e.name}: ${e.message}` });
  }

  // --- D: web api, sessionid ke saath (agar env var me hai)
  if (SESSIONID) {
    try {
      const r = await tierWebApi(u, jar, true);
      attempts.push({ tier: 'web-api-session', ...r });
    } catch (e) {
      attempts.push({ tier: 'web-api-session', ok: false, reason: `${e.name}: ${e.message}` });
    }
  } else {
    attempts.push({ tier: 'web-api-session', ok: false, reason: 'IG_SESSIONID is not set, tier skipped' });
  }

  const winner = attempts.find((a) => a.ok) || null;

  return res.status(200).json({
    // Ye ek line hi poora jawab hai
    verdict: winner
      ? `BUILDABLE via ${winner.tier}`
      : 'NOT BUILDABLE from this server right now',
    workingTier: winner ? winner.tier : null,
    followers: winner ? winner.followers : null,
    postsWithLikeCounts: winner ? winner.postsWithLikeCounts : null,
    username: u,
    hadSessionId: Boolean(SESSIONID),
    tookMs: Date.now() - startedAt,
    attempts,
  });
}
