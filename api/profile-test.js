// ============================================================
//  PROBE v7  —  Aayush ke browser ke HUBAHU headers
//
//  Ye probe andaze par nahi bana. Aayush ne apne Chrome ka
//  "Copy as fetch" bheja aur usme ek cheez turant dikhi:
//
//      Uska browser :  sec-fetch-site: same-origin
//      Mere probes  :  sec-fetch-site: none
//
//  `none` = user ne URL seedha type kiya.
//  `same-origin` = instagram.com ke kisi page se navigate karke aaya.
//
//  Aur v5 me Instagram ne error me NAAM LEKAR bataya tha:
//  "SecFetch Policy violation." Wo policy yahi dekh rahi thi, aur
//  main har round me galat value bhej raha tha.
//
//  Doosri galti: mera UA Chrome 131 bata raha tha, uska browser 152
//  hai. 21 version purana client apne aap me ek bot signal hai.
//
//  Aur ye headers bhi gayab the: priority, dpr, viewport-width,
//  sec-ch-prefers-color-scheme, sec-ch-ua-model, aur accept me
//  application/signed-exchange.
//
//  Ab sab hubahu waisa hai. Cookies uski nahi li gayi — hum apni
//  guest cookies khud banate hain.
//
//  ---------------------------------------------------------------
//  Aur ek badi galti jo aaj pakdi gayi:
//
//  v5/v6 me main MOBILE endpoint (i.instagram.com) par bhi sec-fetch
//  aur referer headers bhej raha tha. Android app ye bhejta hi nahi.
//  Isi wajah se Instagram ne "SecFetch Policy violation" bola tha —
//  main app hone ka daawa kar raha tha par browser ke kaagaz dikha
//  raha tha. reel.js ka mobile tier sirf 6 headers bhejta hai aur
//  roz chalta hai. Ab yahan bhi hubahu wahi 6 hain.
//
//  Do naye darwaze bhi khole gaye hain jo aaj tak try nahi hue:
//    3b  wahi web_profile_info url, par Android UA ke saath
//    3c  wahi endpoint i.instagram.com host par
//  Ab tak maine hamesha browser UA + www ka combination try kiya tha,
//  aur reel.js ki kamyabi thik iske ulte combination se aati hai.
//
//  Chalao:
//   /api/profile-test?u=natgeo&post=https://www.instagram.com/reel/DbdoGAQMg8O/
// ============================================================

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const IG_APP_ID = '936619743392459';
const SESSIONID = process.env.IG_SESSIONID || '';
const T = 6000;              // per request
const BUDGET = 24000;        // poore probe ka waqt

// Chrome 152, bilkul uske browser jaisa
const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const UA_MOBILE =
  'Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2400; ' +
  'samsung; SM-G991B; o1s; exynos2100; en_US; 526face9)';

/* Client hints ka poora set, uske Copy as fetch se hubahu */
const CH = {
  'sec-ch-prefers-color-scheme': 'dark',
  'sec-ch-ua': '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
  'sec-ch-ua-full-version-list':
    '"Chromium";v="152.0.7977.82", "Not?A_Brand";v="24.0.0.0", "Google Chrome";v="152.0.7977.82"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-model': '""',
  'sec-ch-ua-platform': '"Windows"',
  'sec-ch-ua-platform-version': '"19.0.0"',
  dpr: '1.25',
  'viewport-width': '663',
};

/**
 * Page navigation ke headers, uske browser jaise.
 * site = 'same-origin' hi asli badlaav hai. 'none' ab default nahi.
 */
function pageHeaders(cookie, site = 'same-origin') {
  const h = {
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'max-age=0',
    priority: 'u=0, i',
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': site,
    'sec-fetch-user': '?1',
    'upgrade-insecure-requests': '1',
    'user-agent': UA_WEB,
    ...CH,
  };
  // same-origin ka matlab hai kahin se navigate karke aaya, isliye
  // referer bhi hona chahiye warna baat aapas me nahi milti
  if (site === 'same-origin') h.referer = 'https://www.instagram.com/';
  if (cookie) h.cookie = cookie;
  return h;
}

/**
 * Mobile aur web ke headers ALAG rakhne zaroori hain.
 *
 * v5 me Instagram ne साफ़ shabdon me kaha tha: "SecFetch Policy violation."
 * Wajah ye thi ki main mobile app ke endpoint par `sec-fetch-site`,
 * `sec-fetch-mode`, `sec-fetch-dest`, `priority` aur `referer` bhej raha
 * tha. Android app ye headers bhejta hi NAHI hai — ye sirf browser bhejta
 * hai. Yaani main app hone ka daawa kar raha tha par browser ke kaagaz
 * dikha raha tha, aur Instagram ne wahi pakda.
 *
 * reel.js ka mobile tier roz kaam karta hai aur wo bilkul ye chhe headers
 * bhejta hai, ek bhi zyada nahi. Yahan hubahu wahi rakha hai.
 */
function apiHeaders(cookie, mobile) {
  if (mobile) {
    const h = {
      'User-Agent': UA_MOBILE,
      'X-IG-App-ID': IG_APP_ID,
      'X-IG-Capabilities': '3brTvw==',
      'X-IG-Connection-Type': 'WIFI',
      'Accept-Language': 'en-US',
      Accept: '*/*',
    };
    if (cookie) h.Cookie = cookie;
    return h;                       // koi sec-fetch nahi, koi referer nahi
  }
  const h = {
    'user-agent': UA_WEB,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'x-ig-app-id': IG_APP_ID,
    'x-asbd-id': '129477',
    'x-ig-www-claim': '0',
    'x-requested-with': 'XMLHttpRequest',
    ...CH,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    priority: 'u=1, i',
    referer: 'https://www.instagram.com/',
  };
  if (cookie) h.cookie = cookie;
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

/* Apni guest cookies, uski nahi. Homepage ko bhi ab same headers se
   maangte hain, warna pehli request par hi pakde jaate. */
async function guestCookie() {
  const jar = {};
  try {
    const r = await fetch('https://www.instagram.com/', {
      headers: pageHeaders(null, 'none'),   // homepage par none hi sahi hai
      signal: AbortSignal.timeout(T),
    });
    for (const c of r.headers.getSetCookie?.() || []) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    const html = await r.text();
    if (!jar.csrftoken) {
      const m = html.match(/"csrf_token"\s*:\s*"([^"]+)"/);
      if (m) jar.csrftoken = m[1];
    }
  } catch {}
  return { jar, str: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
}

const MARKERS = ['follower_count', 'edge_followed_by', 'profile_pic_url', 'biography', 'media_count'];
function grabFollowers(t) {
  let m = t.match(/"follower_count"\s*:\s*(\d+)/);
  if (m) return Number(m[1]);
  m = t.match(/"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/);
  if (m) return Number(m[1]);
  m = t.match(/title="([\d,]{4,})"/);
  if (m) return Number(m[1].replace(/,/g, ''));
  return null;
}
function countLikes(t) {
  const a = t.match(/"like_count"\s*:\s*\d+/g);
  const b = t.match(/"edge_liked_by"\s*:\s*\{\s*"count"/g);
  return Math.max(a ? a.length : 0, b ? b.length : 0);
}
function peek(t, n, pad = 110) {
  const i = t.indexOf(n);
  return i === -1 ? null : t.slice(Math.max(0, i - 25), i + n.length + pad);
}
function findDeep(o, key, d = 0) {
  if (!o || typeof o !== 'object' || d > 8) return null;
  if (o[key] != null && typeof o[key] !== 'object') return o[key];
  for (const k of Object.keys(o)) {
    const v = findDeep(o[k], key, d + 1);
    if (v != null) return v;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const u = String(req.query.u || '').trim().replace(/^@/, '');
  const postCode = shortcodeOf(req.query.post);
  if (!u && !postCode) {
    return res.status(400).json({ error: 'Pass ?u=natgeo and optionally &post=<reel link>' });
  }

  const startedAt = Date.now();
  const attempts = [];
  let followers = null, pk = null, posts = 0;

  const push = async (tier, fn) => {
    if (Date.now() - startedAt > BUDGET) { attempts.push({ tier, skipped: 'out of time' }); return; }
    try { attempts.push({ tier, ...(await fn()) }); }
    catch (e) { attempts.push({ tier, error: `${e.name}: ${e.message}` }); }
  };

  const { jar, str: cookie } = await guestCookie();

  // === Tier 1: profile page, sec-fetch-site: same-origin ===
  // Yahi wo ek badlaav hai jo pehle kabhi try nahi hua.
  if (u) {
    await push('1 page same-origin', async () => {
      const r = await fetch(`https://www.instagram.com/${encodeURIComponent(u)}/`, {
        headers: pageHeaders(cookie, 'same-origin'),
        redirect: 'follow',
        signal: AbortSignal.timeout(T),
      });
      const t = await r.text();
      const f = grabFollowers(t), l = countLikes(t);
      if (f != null && followers == null) followers = f;
      if (l > posts) posts = l;
      const mk = {};
      for (const m of MARKERS) mk[m] = t.includes(m);
      return { status: r.status, length: t.length, markers: mk, followers: f, likeCounts: l, peek: peek(t, 'follower_count') };
    });

    // Purana wala bhi rakhte hain taki farak saaf dikhe
    await push('2 page none (old way)', async () => {
      const r = await fetch(`https://www.instagram.com/${encodeURIComponent(u)}/`, {
        headers: pageHeaders(cookie, 'none'),
        redirect: 'follow',
        signal: AbortSignal.timeout(T),
      });
      const t = await r.text();
      const f = grabFollowers(t);
      if (f != null && followers == null) followers = f;
      return { status: r.status, length: t.length, followers: f };
    });
  }

  // === Tier 3: web API, ab poore Chrome 152 headers ke saath ===
  if (u && followers == null) {
    await push('3 web_profile_info', async () => {
      const r = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`,
        { headers: { ...apiHeaders(cookie, false), referer: `https://www.instagram.com/${u}/`,
                     ...(jar.csrftoken ? { 'x-csrftoken': jar.csrftoken } : {}) },
          signal: AbortSignal.timeout(T) }
      );
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      const f = grabFollowers(t);
      const p = findDeep(j, 'pk');
      if (f != null && followers == null) followers = f;
      if (p && !pk) pk = String(p);
      return { status: r.status, length: t.length, followers: f, pk: p, sample: t.slice(0, 160) };
    });
  }

  /* === Tier 3b: WAHI url, par Android app ka UA ===
     Ye sabse zaroori naya test hai. reel.js isliye chalta hai kyunki
     wo Instagram ke MOBILE surface se baat karta hai. Maine aaj tak
     web_profile_info ko sirf browser UA ke saath maanga tha aur 429
     mila. Same url + mobile UA kabhi try hi nahi kiya. */
  if (u && followers == null) {
    await push('3b web_profile_info [mobile UA]', async () => {
      const r = await fetch(
        `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`,
        { headers: apiHeaders(null, true), signal: AbortSignal.timeout(T) }
      );
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      const f = grabFollowers(t), p = findDeep(j, 'pk');
      if (f != null && followers == null) followers = f;
      if (p && !pk) pk = String(p);
      const l = countLikes(t);
      if (l > posts) posts = l;
      return { status: r.status, length: t.length, followers: f, pk: p, likeCounts: l, sample: t.slice(0, 160) };
    });
  }

  /* === Tier 3c: wahi endpoint par i.instagram.com host se ===
     www aur i. do alag gateways hain. i. par ab tak sirf usernameinfo
     try hua tha. web_profile_info kabhi nahi. */
  if (u && followers == null) {
    await push('3c web_profile_info [i.instagram.com]', async () => {
      const r = await fetch(
        `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`,
        { headers: apiHeaders(null, true), signal: AbortSignal.timeout(T) }
      );
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      const f = grabFollowers(t), p = findDeep(j, 'pk');
      if (f != null && followers == null) followers = f;
      if (p && !pk) pk = String(p);
      const l = countLikes(t);
      if (l > posts) posts = l;
      return { status: r.status, length: t.length, followers: f, pk: p, likeCounts: l, sample: t.slice(0, 160) };
    });
  }

  // === Tier 4: usernameinfo, mobile UA. v5 me yahin SecFetch error aaya tha ===
  if (u && followers == null) {
    await push('4 usernameinfo', async () => {
      const r = await fetch(`https://i.instagram.com/api/v1/users/${encodeURIComponent(u)}/usernameinfo/`, {
        headers: apiHeaders(null, true), signal: AbortSignal.timeout(T),
      });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      const f = grabFollowers(t), p = findDeep(j, 'pk');
      if (f != null && followers == null) followers = f;
      if (p && !pk) pk = String(p);
      return { status: r.status, length: t.length, followers: f, pk: p, sample: t.slice(0, 160) };
    });
  }

  // === Tier 5: post se pk. BINA sessionid, kyunki wo mari hui hai
  //     aur v5 me usi ne 403 logout_reason 8 diya tha ===
  if (postCode && !pk) {
    const mid = shortcodeToMediaId(postCode);
    await push('5 post -> pk [no session]', async () => {
      const r = await fetch(`https://i.instagram.com/api/v1/media/${mid}/info/`, {
        headers: apiHeaders(null, true), signal: AbortSignal.timeout(T),
      });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      const p = findDeep(j?.items?.[0]?.user || j, 'pk');
      const f = grabFollowers(t);
      if (p && !pk) pk = String(p);
      if (f != null && followers == null) followers = f;
      return { status: r.status, length: t.length, pk: p, followers: f, sample: t.slice(0, 160) };
    });
  }

  // === Tier 6: pk se recent posts ===
  if (pk) {
    await push('6 feed/user/{pk}', async () => {
      const r = await fetch(`https://i.instagram.com/api/v1/feed/user/${pk}/?count=12`, {
        headers: apiHeaders(null, true), signal: AbortSignal.timeout(T),
      });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      const items = (j?.items || []).map((x) => ({
        code: x.code, likes: x.like_count, comments: x.comment_count, takenAt: x.taken_at,
      })).filter((x) => x.likes != null);
      if (items.length) posts = items.length;
      return { status: r.status, length: t.length, postsReturned: items.length,
               firstThree: items.slice(0, 3), sample: items.length ? null : t.slice(0, 160) };
    });
    if (followers == null) {
      await push('7 users/{pk}/info', async () => {
        const r = await fetch(`https://i.instagram.com/api/v1/users/${pk}/info/`, {
          headers: apiHeaders(null, true), signal: AbortSignal.timeout(T),
        });
        const t = await r.text();
        const f = grabFollowers(t);
        if (f != null) followers = f;
        return { status: r.status, length: t.length, followers: f, sample: t.slice(0, 160) };
      });
    }
  }

  const ok = followers != null && posts >= 3;
  const sameOrigin = attempts.find((a) => a.tier.startsWith('1 '));
  const none = attempts.find((a) => a.tier.startsWith('2 '));

  return res.status(200).json({
    verdict: ok ? 'BUILDABLE — followers and post counts both came through'
      : followers != null ? 'PARTIAL — followers yes, posts no'
      : posts ? 'PARTIAL — posts yes, followers no'
      : 'still nothing',
    // Yahi is round ka asli sawaal hai
    secFetchMadeADifference:
      sameOrigin && none
        ? (sameOrigin.length || 0) !== (none.length || 0) || Boolean(sameOrigin.followers) !== Boolean(none.followers)
        : null,
    followers, pk, postsFound: posts,
    cookiesCollected: Object.keys(jar),
    hadSessionId: Boolean(SESSIONID),
    tookMs: Date.now() - startedAt,
    attempts,
  });
}
