// ============================================================
//  PROBE v5  —  MOBILE API SURFACE
//
//  v1 se v4 tak meri galti ek hi thi: maine chaar baar WEB surface
//  test kiya. Vercel ka web page, Vercel ka web API, Cloudflare ka
//  web page. Sab ek hi darwaza.
//
//  reel.js me ek DOOSRA surface hai jo Vercel se KAAM KARTA HAI:
//
//      i.instagram.com/api/v1/media/{id}/info/
//      User-Agent: Instagram Android app
//      X-IG-Capabilities: 3brTvw==
//
//  Ye Android app ka API hai. Mere profile probes ne i.instagram.com
//  par bhi WEB ka User-Agent bheja, jo turant pakda jaata hai.
//
//  Us surface par profile ke apne endpoints hain:
//      /users/{username}/usernameinfo/    follower_count
//      /users/{pk}/info/                  wahi, numeric id se
//      /feed/user/{pk}/?count=12          recent posts, likes+comments
//
//  Aur pk hume POST se mil sakta hai, aur post fetch pehle se chalta
//  hai. Yani chain ka pehla kadam already proven hai.
//
//  Chalao:
//    /api/profile-test?u=natgeo
//    /api/profile-test?u=natgeo&post=https://www.instagram.com/reel/XXXX/
//
//  Doosra wala zyada taakatwar hai: wo post se pk nikaal kar feed
//  endpoint tak pahunchta hai, bina username lookup par bharosa kiye.
// ============================================================

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const IG_APP_ID = '936619743392459';

// Wahi UA jo reel.js ka chalta hua mobile tier use karta hai
const UA_MOBILE =
  'Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2400; ' +
  'samsung; SM-G991B; o1s; exynos2100; en_US; 526face9)';

const SESSIONID = process.env.IG_SESSIONID || '';
const T = 8000;

/** reel.js ke chalte hue tier jaise hi headers */
function mobileHeaders() {
  const h = {
    'User-Agent': UA_MOBILE,
    'X-IG-App-ID': IG_APP_ID,
    'X-IG-Capabilities': '3brTvw==',
    'X-IG-Connection-Type': 'WIFI',
    'Accept-Language': 'en-US',
    Accept: '*/*',
  };
  if (SESSIONID) h.Cookie = `sessionid=${SESSIONID}`;
  return h;
}

function shortcodeToMediaId(shortcode) {
  let id = 0n;
  for (const ch of shortcode.slice(0, 11)) {
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

async function getJson(url) {
  const r = await fetch(url, { headers: mobileHeaders(), signal: AbortSignal.timeout(T) });
  const text = await r.text();
  let json = null, parseErr = null;
  try { json = JSON.parse(text); } catch (e) { parseErr = 'not JSON'; }
  return { status: r.status, length: text.length, json, parseErr, sample: text.slice(0, 220) };
}

/** Kisi bhi gehraai me follower count dhoondho */
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
/** feed response se posts nikaalo — yahi engagement rate ki jaan hai */
function itemsOf(json) {
  const arr = json?.items || json?.feed_items || [];
  return arr.map((x) => {
    const n = x.media_or_ad || x.media || x;
    return {
      code: n.code || null,
      likes: n.like_count ?? null,
      comments: n.comment_count ?? null,
      plays: n.play_count ?? n.view_count ?? null,
      takenAt: n.taken_at ?? null,
      isVideo: n.media_type === 2,
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

  // --- A: username se seedha profile info (Android app ka apna endpoint)
  if (u) {
    await push('A usernameinfo', async () => {
      const r = await getJson(`https://i.instagram.com/api/v1/users/${encodeURIComponent(u)}/usernameinfo/`);
      const f = findFollowers(r.json), p = findPk(r.json);
      if (f != null) followers = f;
      if (p) pk = p;
      return { status: r.status, length: r.length, followers: f, pk: p, sample: r.sample };
    });
  }

  // --- B: wahi cheez web_profile_info se, par MOBILE UA ke saath
  if (u && followers == null) {
    await push('B web_profile_info + mobile UA', async () => {
      const r = await getJson(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`);
      const f = findFollowers(r.json), p = findPk(r.json);
      if (f != null) followers = f;
      if (p) pk = p;
      return { status: r.status, length: r.length, followers: f, pk: p, sample: r.sample };
    });
  }

  // --- C: post se pk nikaalo. YE RASTA PEHLE SE CHALTA HAI.
  //        reel.js ka mobile tier bilkul yahi call karta hai.
  if (postCode && !pk) {
    await push('C pk from post', async () => {
      const mediaId = shortcodeToMediaId(postCode);
      const r = await getJson(`https://i.instagram.com/api/v1/media/${mediaId}/info/`);
      const p = findPk(r.json), f = findFollowers(r.json);
      if (p) pk = p;
      if (f != null && followers == null) followers = f;
      return {
        status: r.status, length: r.length, pk: p, followers: f,
        // Post ke apne numbers bhi dekh lete hain
        postLikes: r.json?.items?.[0]?.like_count ?? null,
        postComments: r.json?.items?.[0]?.comment_count ?? null,
        sample: r.sample,
      };
    });
  }

  // --- D: pk mil gaya to profile info
  if (pk && followers == null) {
    await push('D users/{pk}/info', async () => {
      const r = await getJson(`https://i.instagram.com/api/v1/users/${pk}/info/`);
      const f = findFollowers(r.json);
      if (f != null) followers = f;
      return { status: r.status, length: r.length, followers: f, sample: r.sample };
    });
  }

  // --- E: SABSE ZAROORI. pk se recent posts, likes aur comments ke saath.
  //        Engagement rate ke liye yahi chahiye.
  if (pk) {
    await push('E feed/user/{pk}', async () => {
      const r = await getJson(`https://i.instagram.com/api/v1/feed/user/${pk}/?count=12`);
      const list = itemsOf(r.json);
      if (list.length) posts = list;
      return {
        status: r.status, length: r.length,
        postsReturned: list.length,
        firstThree: list.slice(0, 3),
        sample: list.length ? null : r.sample,
      };
    });
  }

  const haveEnough = followers != null && posts.length >= 3;

  return res.status(200).json({
    verdict: haveEnough
      ? 'BUILDABLE — followers and post counts both came through on the mobile API'
      : followers != null
        ? 'PARTIAL — followers came through but the post feed did not'
        : posts.length
          ? 'PARTIAL — post feed came through but follower count did not'
          : 'mobile API gave nothing either',
    followers,
    pk,
    postsFound: posts.length,
    hadSessionId: Boolean(SESSIONID),
    username: u || null,
    tookMs: Date.now() - startedAt,
    attempts,
  });
}
