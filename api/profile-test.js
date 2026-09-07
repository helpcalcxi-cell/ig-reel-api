// ============================================================
//  PROBE v6  —  do asli errors theek karke
//
//  v5 ne pehli baar kaam ki baat batayi:
//
//    A usernameinfo  ->  400  "SecFetch Policy violation."
//    C media info    ->  403  logout_reason: 8
//
//  Dono IP block NAHI hain. Dono theek ho sakte hain.
//
//  1. SecFetch Policy violation
//     Mere mobileHeaders() me ek bhi Sec-Fetch-* header nahi tha.
//     Instagram ke kuch endpoints ise sakhti se check karte hain.
//     Ab teeno bhejte hain.
//
//  2. logout_reason: 8
//     Ye MARI HUI sessionid ki wajah se hai. Probe ne Cookie me
//     sessionid bheja kyunki IG_SESSIONID abhi Vercel me set hai.
//     Wo sessionid dead hai, aur usse request TOOT jaati hai —
//     bina uske shayad chal jaati.
//
//     Isliye ab har tier DO baar chalta hai: bina session, aur
//     session ke saath. Nateeja saaf dikha dega ki wo madad kar
//     rahi hai ya nuksaan.
//
//  Chalao:
//    /api/profile-test?u=natgeo&post=https://www.instagram.com/reel/DbdoGAQMg8O/
// ============================================================

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const IG_APP_ID = '936619743392459';

const UA_MOBILE =
  'Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2400; ' +
  'samsung; SM-G991B; o1s; exynos2100; en_US; 526face9)';
const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const SESSIONID = process.env.IG_SESSIONID || '';
const T = 8000;

/**
 * withSession = false hone par sessionid BILKUL nahi jaati.
 * Yahi v5 ki asli galti thi.
 */
function mobileHeaders(withSession) {
  const h = {
    'User-Agent': UA_MOBILE,
    'X-IG-App-ID': IG_APP_ID,
    'X-IG-Capabilities': '3brTvw==',
    'X-IG-Connection-Type': 'WIFI',
    'Accept-Language': 'en-US',
    Accept: '*/*',
    // v5 me ye teeno gayab the. "SecFetch Policy violation." isi ka
    // jawab tha. App apne API call ko same-origin XHR jaisa bhejta hai.
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
  };
  if (withSession && SESSIONID) h.Cookie = `sessionid=${SESSIONID}`;
  return h;
}

function webApiHeaders(withSession, ref) {
  const h = {
    'User-Agent': UA_WEB,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-ig-app-id': IG_APP_ID,
    'x-asbd-id': '129477',
    'x-ig-www-claim': '0',
    'x-requested-with': 'XMLHttpRequest',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: ref,
  };
  if (withSession && SESSIONID) h.Cookie = `sessionid=${SESSIONID}`;
  return h;
}

function shortcodeToMediaId(sc) {
  let id = 0n;
  for (const ch of sc.slice(0, 11)) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) throw new Error('bad shortcode');
    id = id * 64n + BigInt(i);
  }
  return id.toString();
}
function shortcodeOf(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{5,30}$/.test(s) && !s.includes('/')) return s;
  const m = s.match(/instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  return m ? m[1] : null;
}

async function call(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(T) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, length: text.length, json, sample: text.slice(0, 180) };
}

function findFollowers(o, d = 0) {
  if (!o || typeof o !== 'object' || d > 8) return null;
  if (typeof o.follower_count === 'number') return o.follower_count;
  for (const k of Object.keys(o)) {
    const v = findFollowers(o[k], d + 1);
    if (v != null) return v;
  }
  return null;
}
function findPk(o, d = 0) {
  if (!o || typeof o !== 'object' || d > 8) return null;
  if (o.username && (o.pk != null || o.pk_id != null)) return String(o.pk ?? o.pk_id);
  for (const k of Object.keys(o)) {
    const v = findPk(o[k], d + 1);
    if (v) return v;
  }
  return null;
}
function itemsOf(json) {
  const arr = json?.items || [];
  return arr.map((x) => {
    const n = x.media_or_ad || x.media || x;
    return {
      code: n.code || null,
      likes: n.like_count ?? null,
      comments: n.comment_count ?? null,
      plays: n.play_count ?? n.view_count ?? null,
      takenAt: n.taken_at ?? null,
    };
  }).filter((p) => p.likes != null || p.comments != null);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const u = String(req.query.u || '').trim().replace(/^@/, '');
  const postCode = shortcodeOf(req.query.post);
  if (!u && !postCode) {
    return res.status(400).json({ error: 'Pass ?u=natgeo and optionally &post=<a reel link>' });
  }

  const startedAt = Date.now();
  const attempts = [];
  let pk = null, followers = null, posts = [];

  const push = async (tier, fn) => {
    try { attempts.push({ tier, ...(await fn()) }); }
    catch (e) { attempts.push({ tier, error: `${e.name}: ${e.message}` }); }
  };

  /* Har call do baar: bina session, phir session ke saath. Isse
     saaf pata chalega ki mari hui sessionid madad kar rahi hai ya
     request tod rahi hai. */
  const both = async (label, url, headerFn) => {
    await push(`${label} [no session]`, async () => {
      const r = await call(url, headerFn(false));
      const f = findFollowers(r.json), p = findPk(r.json);
      if (f != null && followers == null) followers = f;
      if (p && !pk) pk = p;
      return { status: r.status, length: r.length, followers: f, pk: p, sample: r.sample };
    });
    if (SESSIONID) {
      await push(`${label} [with session]`, async () => {
        const r = await call(url, headerFn(true));
        const f = findFollowers(r.json), p = findPk(r.json);
        if (f != null && followers == null) followers = f;
        if (p && !pk) pk = p;
        return { status: r.status, length: r.length, followers: f, pk: p, sample: r.sample };
      });
    }
  };

  // --- A: usernameinfo. v5 me yahan "SecFetch Policy violation." aaya tha.
  if (u) {
    await both(
      'A usernameinfo',
      `https://i.instagram.com/api/v1/users/${encodeURIComponent(u)}/usernameinfo/`,
      (s) => mobileHeaders(s)
    );
  }

  // --- B: wahi cheez web API se, ab Sec-Fetch ke saath
  if (u && followers == null) {
    await both(
      'B web_profile_info',
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`,
      (s) => webApiHeaders(s, `https://www.instagram.com/${u}/`)
    );
  }

  // --- C: post se pk. v5 me yahan 403 logout_reason 8 aaya tha,
  //        yaani MARI HUI SESSIONID ne request todi thi.
  if (postCode && !pk) {
    const mediaId = shortcodeToMediaId(postCode);
    await both(
      'C pk from post',
      `https://i.instagram.com/api/v1/media/${mediaId}/info/`,
      (s) => mobileHeaders(s)
    );
  }

  // --- D: pk se profile info
  if (pk && followers == null) {
    await both('D users/{pk}/info', `https://i.instagram.com/api/v1/users/${pk}/info/`, (s) => mobileHeaders(s));
  }

  // --- E: pk se recent posts. Engagement rate ki asli jaan.
  if (pk) {
    await push('E feed/user/{pk} [no session]', async () => {
      const r = await call(`https://i.instagram.com/api/v1/feed/user/${pk}/?count=12`, mobileHeaders(false));
      const list = itemsOf(r.json);
      if (list.length) posts = list;
      return { status: r.status, length: r.length, postsReturned: list.length, firstThree: list.slice(0, 3), sample: list.length ? null : r.sample };
    });
    if (!posts.length && SESSIONID) {
      await push('E feed/user/{pk} [with session]', async () => {
        const r = await call(`https://i.instagram.com/api/v1/feed/user/${pk}/?count=12`, mobileHeaders(true));
        const list = itemsOf(r.json);
        if (list.length) posts = list;
        return { status: r.status, length: r.length, postsReturned: list.length, firstThree: list.slice(0, 3), sample: list.length ? null : r.sample };
      });
    }
  }

  const ok = followers != null && posts.length >= 3;

  /* Sessionid madad kar rahi hai ya nuksaan — seedha jawab */
  let sessionVerdict = 'not set';
  if (SESSIONID) {
    const noSess = attempts.filter((a) => a.tier.includes('[no session]') && a.status && a.status < 400).length;
    const withSess = attempts.filter((a) => a.tier.includes('[with session]') && a.status && a.status < 400).length;
    sessionVerdict = withSess > noSess ? 'helping'
      : noSess > withSess ? 'HURTING — remove IG_SESSIONID from Vercel'
      : 'no difference';
  }

  return res.status(200).json({
    verdict: ok
      ? 'BUILDABLE — followers and post counts both came through'
      : followers != null ? 'PARTIAL — followers yes, post feed no'
      : posts.length ? 'PARTIAL — post feed yes, followers no'
      : 'still nothing',
    followers,
    pk,
    postsFound: posts.length,
    sessionidVerdict: sessionVerdict,
    username: u || null,
    tookMs: Date.now() - startedAt,
    attempts,
  });
}
