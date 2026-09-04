// ============================================================
//  Instagram Reel Downloader API  —  v8
//
//  v8 me do hi cheezein badli hain. Dono naap kar badli hain, tukke se nahi.
//
//  1. TIER KA KRAM BADLA
//
//     v7 me sabse pehle mobile-api chalta tha (i.instagram.com) — yaani
//     Instagram APP ka darwaza. Wahi darwaza `logout_reason: 33` bhejta tha,
//     aur account ek din me mar jaata tha.
//
//     Ek competitor (igexport.com) ke CDN link ke andar `urlgen_source: "www"`
//     likha mila — matlab wo WEB ka darwaza istemaal karte hain, app ka nahi.
//     Aur wo zinda hain.
//
//     Test me dono chale: web-api ✅ aur mobile-api ✅ (dono session ke saath,
//     Vercel ke apne IP se). To ab web-api pehle, mobile-api backup me.
//
//     Ye pakka saabit nahi hua ki isse account zyada jiyega — par ishara saaf
//     hai, aur galat nikla to bhi nuksaan zero: mobile-api doosre number par
//     khada hai, jaise pehle pehle number par tha.
//
//  2. GUEST COOKIES AB CACHE HOTI HAIN
//
//     v7 har request par instagram.com ka homepage (616 KB) download karta tha
//     sirf csrftoken uthane ke liye. Naapa to pata chala ki ye ek request poore
//     data kharche ka 93% kha rahi thi. Ab jar 30 minute cache hota hai.
//
//  Tier 1: Web API     (www.instagram.com — igexport bhi yahi use karte hain)
//  Tier 2: Mobile API  (i.instagram.com — backup)
//  Tier 3: Embed page
//  Tier 4: GraphQL     (⚠️ doc_id purana hai, "execution error" deta hai —
//                       isliye aakhir me. Naya doc_id mile to IG_DOC_ID env
//                       var me daal dena, ye apne aap upar aa jayega.)
//
//  CDN cache andar hi hai — WordPress plugin ki zaroorat nahi.
//  Debug: /api/reel?url=<link>&debug=1
// ============================================================

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const IG_APP_ID = '936619743392459';

// ⚠️ Instagram ye har 2-4 hafte badalta hai. Vercel env var IG_DOC_ID se override karo.
const DOC_ID = process.env.IG_DOC_ID || '8845758582119845';

const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Instagram Android app ka UA — mobile endpoint isi ko pehchanta hai
const UA_MOBILE =
  'Instagram 302.0.0.23.114 Android (33/13; 420dpi; 1080x2400; ' +
  'samsung; SM-G991B; o1s; exynos2100; en_US; 526face9)';

// Agar aapke paas throwaway account ka sessionid ho to Vercel env var me daal do.
// Iske bina bhi try hoga, par iske saath success rate bahut zyada hai.
const SESSIONID = process.env.IG_SESSIONID || '';

// ---------------------------------------------------------------- helpers

function extractShortcode(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^[A-Za-z0-9_-]{5,30}$/.test(s) && !s.includes('/')) return s;
  const m = s.match(
    /instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i
  );
  return m ? m[1] : null;
}

function shortcodeToMediaId(shortcode) {
  let id = 0n;
  for (const ch of shortcode.slice(0, 11)) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) throw new Error('Invalid shortcode');
    id = id * 64n + BigInt(i);
  }
  return id.toString();
}

function clean(s) {
  return s
    .replace(/\\u0026/g, '&')
    .replace(/\\u003C/gi, '<')
    .replace(/\\u003E/gi, '>')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ');
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) return clean(m[1]);
  }
  return null;
}

/** Response HTML hai ya JSON — ye batata hai ki humein data mila ya web page */
function looksLikeHtml(text) {
  return /^\s*<(?:!doctype|html)/i.test(text);
}

/**
 * Instagram ka apna error message nikaalta hai.
 * Ye alag field me isliye rakhte hain kyunki diagnosis ko iski zaroorat
 * production me bhi hoti hai — jabki raw `sample` sirf debug me jaata hai.
 */
function igMessageFrom(text) {
  try {
    const j = JSON.parse(text);
    return j.message || j.error_title || j.errors?.[0]?.message || j.error_type || null;
  } catch {
    return null;
  }
}

/**
 * Instagram ke jawab ke wo ishaare jo diagnose() ko CHAHIYE.
 *
 * ⚠️ Ye alag function isliye hai: `sample` (poora raw body) debug ke bina strip
 * ho jaata hai, aur `logout_reason` sirf usi me hota tha. Nateeja ye tha ki
 * LIVE par SESSION_KILLED kabhi diagnose hi nahi ho paata tha — hamesha
 * SESSION_REJECTED aata tha, jo bilkul alag ilaaj batata hai:
 *
 *   SESSION_KILLED   -> account mar gaya, NAYA account banao
 *   SESSION_REJECTED -> sessionid galat copy hui / expire, DOBARA copy karo
 *
 * Ye chhota object hamesha bheja jaata hai, debug ho ya na ho.
 */
function igSignals(text) {
  try {
    const j = JSON.parse(text);
    const out = {};
    if (j.error_title) out.error_title = j.error_title;
    if (j.logout_reason !== undefined) out.logout_reason = j.logout_reason;
    if (j.require_login) out.require_login = true;
    if (j.checkpoint_url || j.challenge || j.challenge_required) out.challenge_required = true;
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------- cookies

/**
 * Instagram se guest cookies leta hai (csrftoken, mid, ig_did).
 * Inke bina web endpoints sirf khaali page dete hain — v2 me yahi galti thi.
 */
// Ek warm serverless instance kai requests handle karta hai. v7 me har request
// par ye 616 KB ka homepage dobara utrta tha — bekaar. 30 minute cache kaafi hai:
// csrftoken itni jaldi badalta nahi, aur galat ho bhi jaye to neeche wala
// refresh-and-retry use theek kar deta hai.
const COOKIE_TTL = 30 * 60 * 1000;
let COOKIE_CACHE = { jar: null, at: 0, inflight: null };

/**
 * Cache se jar deta hai. `force` par Instagram se naya lekar aata hai.
 * Ek saath aayi kai requests ek hi fetch ka intezaar karti hain (inflight),
 * warna instance garam hote hi 10 requests 10 homepage utaar deti.
 */
async function getJar(force = false) {
  const now = Date.now();
  if (!force && COOKIE_CACHE.jar && now - COOKIE_CACHE.at < COOKIE_TTL) {
    return { jar: COOKIE_CACHE.jar, cached: true, ageMs: now - COOKIE_CACHE.at };
  }
  if (COOKIE_CACHE.inflight) return COOKIE_CACHE.inflight;

  COOKIE_CACHE.inflight = (async () => {
    try {
      const c = await getGuestCookies();
      COOKIE_CACHE = { jar: c.jar, at: Date.now(), inflight: null };
      return { jar: c.jar, cached: false, ageMs: 0, status: c.status, got: c.got };
    } catch (e) {
      COOKIE_CACHE.inflight = null;
      throw e;
    }
  })();

  return COOKIE_CACHE.inflight;
}

async function getGuestCookies() {
  const res = await fetch('https://www.instagram.com/', {
    headers: {
      'User-Agent': UA_WEB,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Upgrade-Insecure-Requests': '1',
    },
    redirect: 'follow',
  });

  const jar = {};
  for (const line of res.headers.getSetCookie?.() || []) {
    const [pair] = line.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }

  // kabhi-kabhi cookie header me nahi, page ke andar hota hai
  if (!jar.csrftoken) {
    const html = await res.text();
    const m = html.match(/"csrf_token":"([^"]+)"/);
    if (m) jar.csrftoken = m[1];
  }

  return { jar, status: res.status, got: Object.keys(jar) };
}

/**
 * sessionid ke andar hi user id chhupa hota hai: "12345678%3AabcXYZ%3A12%3A..."
 * Instagram kai endpoints par ds_user_id cookie bhi maangta hai.
 */
function dsUserIdFromSession(sid) {
  if (!sid) return null;
  const first = decodeURIComponent(String(sid)).split(':')[0];
  return /^\d+$/.test(first) ? first : null;
}

function cookieHeader(jar) {
  const all = { ...jar };
  if (SESSIONID) {
    all.sessionid = SESSIONID;
    const ds = dsUserIdFromSession(SESSIONID);
    if (ds) all.ds_user_id = ds;
  }
  return Object.entries(all)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * Instagram ke jawab ko aam bhasha me badalta hai, taki har baar
 * raw JSON padh kar guess na karna pade.
 */
function diagnose(attempts, hasSession) {
  const blob = JSON.stringify(attempts);

  // Reel khud hi nahi hai (private/deleted) — ye humari galti nahi hai.
  // Ise alag pehchanna zaroori hai kyunki iska HTTP status alag hota hai (neeche dekho).
  if (attempts.some((a) => a.status === 404) && !/login_required|require_login|challenge/i.test(blob)) {
    return {
      code: 'REEL_NOT_FOUND',
      meaning: 'Ye reel private hai, delete ho gayi hai, ya link galat hai.',
      reelFault: true,
    };
  }

  if (/challenge_required|checkpoint_required/i.test(blob)) {
    return {
      code: 'CHALLENGE',
      meaning: 'Instagram ne account par verification laga di. Ye account ab is server se kaam nahi karega — naya account banana padega.',
    };
  }
  if (/logout_reason|You.{0,3}ve Been Logged Out/i.test(blob) && hasSession) {
    return {
      code: 'SESSION_KILLED',
      meaning: 'sessionid mar chuka hai. Account ban hua ya Instagram ne logout kar diya.',
    };
  }
  if (/login_required|require_login/i.test(blob)) {
    return hasSession
      ? {
          code: 'SESSION_REJECTED',
          meaning: 'sessionid accept nahi hua — galat copy hua, expire ho gaya, ya IP ki wajah se reject hua.',
        }
      : {
          code: 'NEED_LOGIN',
          meaning: 'Anonymous access band hai. Vercel me IG_SESSIONID env var set karo.',
        };
  }
  if (/Please wait a few minutes|rate.?limit|Try again later/i.test(blob)) {
    return {
      code: 'RATE_LIMITED',
      meaning: 'Server ka IP flag ho chuka hai. Thodi der baad chal sakta hai, par asli ilaaj residential proxy hai.',
    };
  }
  if (/isAppShell":true/.test(blob)) {
    return {
      code: 'APP_SHELL',
      meaning: 'Instagram ne data ki jagah khaali web page bheja — humein logged-out visitor maan raha hai.',
    };
  }
  return { code: 'UNKNOWN', meaning: 'Pehchana nahi gaya. Poora attempts output bhejo.' };
}

function webHeaders(jar, extra = {}) {
  return {
    'User-Agent': UA_WEB,
    'Accept-Language': 'en-US,en;q=0.9',
    'x-ig-app-id': IG_APP_ID,
    'x-requested-with': 'XMLHttpRequest',
    'x-csrftoken': jar.csrftoken || '',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    Cookie: cookieHeader(jar),
    ...extra,
  };
}

// ---------------------------------------------------------------- normalize

/** Ek node ka apna poster nikaalta hai — carousel me har slide ka alag hota hai */
function posterOf(node) {
  if (node.display_url) return clean(node.display_url);
  const c = node.image_versions2?.candidates || [];
  const best = [...c].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return best ? best.url : null;
}

function pickBest(node) {
  const poster = posterOf(node);

  // ⚠️ `thumb` har item ka APNA hona chahiye. Post ka cover sabko de doge to
  // 9-slide carousel me nau baar wahi ek photo dikhegi.
  if (node.video_url) return { type: 'video', url: clean(node.video_url), thumb: poster };

  if (node.video_versions?.length) {
    const best = [...node.video_versions].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    return { type: 'video', url: best.url, width: best.width, height: best.height, thumb: poster };
  }
  return poster ? { type: 'image', url: poster, thumb: poster } : null;
}

/** GraphQL shape -> standard shape */
function fromGraphNode(m, shortcode) {
  const nodes = m.edge_sidecar_to_children?.edges?.length
    ? m.edge_sidecar_to_children.edges.map((e) => e.node)
    : [m];
  const media = nodes.map(pickBest).filter(Boolean);
  const firstVideo = media.find((x) => x.type === 'video');

  return {
    shortcode: m.shortcode || shortcode,
    is_video: Boolean(firstVideo),
    video_url: firstVideo?.url || null,
    thumbnail_url: m.display_url ? clean(m.display_url) : null,
    username: m.owner?.username || null,
    full_name: m.owner?.full_name || null,
    caption: m.edge_media_to_caption?.edges?.[0]?.node?.text || '',
    duration: m.video_duration || null,
    likes: m.edge_media_preview_like?.count ?? m.edge_liked_by?.count ?? null,
    views: m.video_view_count ?? m.video_play_count ?? null,
    audio_url: null,
    media,
  };
}

/** REST (v1) shape -> standard shape */
function fromRestItem(item, shortcode) {
  const nodes = item.carousel_media?.length ? item.carousel_media : [item];
  const media = nodes.map(pickBest).filter(Boolean);
  const firstVideo = media.find((x) => x.type === 'video');

  // Instagram alag jagah alag naam deta hai, isliye teeno dekhne padte hain
  const clips = item.clips_metadata || {};
  const audio =
    clips.original_sound_info?.progressive_download_url ||
    clips.music_info?.music_asset_info?.progressive_download_url ||
    null;

  return {
    shortcode: item.code || shortcode,
    is_video: Boolean(firstVideo),
    video_url: firstVideo?.url || null,
    thumbnail_url: item.image_versions2?.candidates?.[0]?.url || null,
    username: item.user?.username || null,
    full_name: item.user?.full_name || null,
    caption: item.caption?.text || '',
    duration: item.video_duration || null,
    likes: item.like_count ?? null,
    views: item.play_count ?? item.view_count ?? item.video_view_count ?? null,
    audio_url: audio,
    media,
  };
}

// ---------------------------------------------------------------- TIER 1
async function fromGraphQL(shortcode, jar) {
  const body = new URLSearchParams({
    variables: JSON.stringify({
      shortcode,
      fetch_tagged_user_count: null,
      hoisted_comment_id: null,
      hoisted_reply_id: null,
    }),
    doc_id: DOC_ID,
    server_timestamps: 'true',
  });

  const res = await fetch('https://www.instagram.com/graphql/query/', {
    method: 'POST',
    headers: webHeaders(jar, {
      'content-type': 'application/x-www-form-urlencoded',
      Accept: '*/*',
      Origin: 'https://www.instagram.com',
      Referer: `https://www.instagram.com/reel/${shortcode}/`,
    }),
    body,
  });

  const text = await res.text();

  if (looksLikeHtml(text)) {
    return { ok: false, reason: `graphql ne HTML bheja (status ${res.status}) — cookies/doc_id kaam nahi kiye`, status: res.status, sample: text.slice(0, 300) };
  }
  if (!res.ok) {
    return { ok: false, reason: `graphql HTTP ${res.status}`, status: res.status, igMessage: igMessageFrom(text), igSignal: igSignals(text), sample: text.slice(0, 400) };
  }

  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, reason: 'graphql JSON parse fail', status: res.status, sample: text.slice(0, 400) }; }

  const m = json?.data?.xdt_shortcode_media || json?.data?.shortcode_media;
  if (!m) {
    return {
      ok: false,
      reason: 'graphql me media null — doc_id purana ho sakta hai',
      status: res.status,
      igMessage: json?.message || json?.errors?.[0]?.message || null,
      sample: text.slice(0, 400),
    };
  }

  return { ok: true, data: { source: 'graphql', ...fromGraphNode(m, shortcode) } };
}

// ---------------------------------------------------------------- TIER 2
// Mobile app ka endpoint — web se alag rules, isliye alag chance.
async function fromMobileApi(shortcode, jar) {
  const mediaId = shortcodeToMediaId(shortcode);

  const headers = {
    'User-Agent': UA_MOBILE,
    'X-IG-App-ID': IG_APP_ID,
    'X-IG-Capabilities': '3brTvw==',
    'X-IG-Connection-Type': 'WIFI',
    'Accept-Language': 'en-US',
    Accept: '*/*',
  };
  if (SESSIONID) {
    const ds = dsUserIdFromSession(SESSIONID);
    headers.Cookie = `sessionid=${SESSIONID}` + (ds ? `; ds_user_id=${ds}` : '');
    if (ds) headers['X-IG-Android-ID'] = `android-${ds.slice(0, 16)}`;
  }

  const res = await fetch(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, { headers });
  const text = await res.text();

  if (looksLikeHtml(text)) {
    return { ok: false, reason: `mobile api ne HTML bheja (status ${res.status})`, status: res.status, sample: text.slice(0, 250) };
  }
  if (!res.ok) {
    return { ok: false, reason: `mobile api HTTP ${res.status}`, status: res.status, igMessage: igMessageFrom(text), igSignal: igSignals(text), sample: text.slice(0, 300) };
  }

  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, reason: 'mobile api JSON parse fail', status: res.status, sample: text.slice(0, 300) }; }

  const item = json?.items?.[0];
  if (!item) {
    return {
      ok: false,
      reason: 'mobile api me items nahi mile',
      status: res.status,
      igMessage: json?.message || json?.error_type || null,
      sample: text.slice(0, 300),
    };
  }

  return { ok: true, data: { source: 'mobile-api', ...fromRestItem(item, shortcode) } };
}

// ---------------------------------------------------------------- TIER 3
async function fromEmbed(shortcode, jar) {
  const res = await fetch(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
    headers: {
      'User-Agent': UA_WEB,
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      Referer: 'https://www.instagram.com/',
      Cookie: cookieHeader(jar),
    },
  });

  if (!res.ok) return { ok: false, reason: `embed HTTP ${res.status}`, status: res.status };
  const html = await res.text();

  const video = firstMatch(html, [
    /"video_url":"(.*?)"/,
    /"video_versions":\[\{[^}]*?"url":"(.*?)"/,
    /property="og:video"\s+content="(.*?)"/,
    /"playable_url(?:_quality_hd)?":"(.*?)"/,
    /"browser_native_(?:hd|sd)_url":"(.*?)"/,
  ]);

  const image = firstMatch(html, [
    /"display_url":"(.*?)"/,
    /class="EmbeddedMediaImage"[^>]*?src="(.*?)"/,
    /property="og:image"\s+content="(.*?)"/,
  ]);

  const username = firstMatch(html, [/"owner":\{[^}]*?"username":"(.*?)"/, /"username":"(.*?)"/]);
  const caption = firstMatch(html, [
    /"edge_media_to_caption".*?"text":"(.*?)"/,
    /<div class="Caption".*?<\/a>(.*?)<div class="CaptionComments"/s,
  ]);

  if (!video && !image) {
    // sirf media CDN links dekho — static.cdninstagram.com icons hote hain, media nahi
    const cdn = [...html.matchAll(/https:\\?\/\\?\/(?:scontent|video)[^"'\s]*?(?:cdninstagram\.com|fbcdn\.net)[^"'\s]*/g)]
      .slice(0, 3)
      .map((x) => clean(x[0]).slice(0, 140));

    return {
      ok: false,
      reason: 'embed me media nahi mila',
      status: res.status,
      htmlLength: html.length,
      mediaCdnLinks: cdn,
      isAppShell: html.length > 300000,
      sample: html.slice(0, 300),
    };
  }

  return {
    ok: true,
    data: {
      source: 'embed',
      shortcode,
      is_video: Boolean(video),
      video_url: video,
      thumbnail_url: image,
      username,
      caption: caption ? caption.replace(/<[^>]+>/g, '').trim().slice(0, 300) : '',
      media: video ? [{ type: 'video', url: video }] : [{ type: 'image', url: image }],
    },
  };
}

// ---------------------------------------------------------------- TIER 4
async function fromWebApi(shortcode, jar) {
  const mediaId = shortcodeToMediaId(shortcode);

  const res = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
    headers: webHeaders(jar, {
      Accept: '*/*',
      Referer: `https://www.instagram.com/p/${shortcode}/`,
    }),
  });

  const text = await res.text();
  if (looksLikeHtml(text)) {
    // Bada HTML matlab poora logged-out app shell — session nahi lagi.
    // Ye flag diagnose() ko chahiye, warna wo UNKNOWN bol deta hai.
    return {
      ok: false,
      reason: `web api ne HTML bheja (status ${res.status})`,
      status: res.status,
      htmlLength: text.length,
      isAppShell: text.length > 300000,
    };
  }
  if (!res.ok) return { ok: false, reason: `web api HTTP ${res.status}`, status: res.status, igMessage: igMessageFrom(text), igSignal: igSignals(text), sample: text.slice(0, 250) };

  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, reason: 'web api JSON parse fail', status: res.status, sample: text.slice(0, 250) }; }

  const item = json?.items?.[0];
  if (!item) {
    return { ok: false, reason: 'web api me items nahi mile', status: res.status, igMessage: json?.message || null };
  }

  return { ok: true, data: { source: 'web-api', ...fromRestItem(item, shortcode) } };
}

// ---------------------------------------------------------------- CDN cache
//
// Yahi wo hissa hai jiski wajah se WordPress plugin ki zaroorat nahi.
// `s-maxage` dekh kar Vercel ka CDN response ko edge par rakh leta hai, aur
// agli baar wahi reel maangne par FUNCTION CHALTA HI NAHI — request Instagram
// tak pahunchti hi nahi. Session utna hi kam ghista hai.
//
// Cache key poora URL hai (query string ke saath), to har reel ki apni entry hai.
// Response me `x-vercel-cache: HIT` aaye to samajh lo cache se aaya.

/** Instagram ke CDN link me `oe=<hex>` uski asli expiry hoti hai */
function secondsUntilExpiry(url) {
  try {
    const oe = new URL(url).searchParams.get('oe');
    if (!oe || !/^[0-9a-f]+$/i.test(oe)) return 0;
    const left = parseInt(oe, 16) - Math.floor(Date.now() / 1000);
    return left > 0 ? left : 0;
  } catch {
    return 0;
  }
}

/**
 * Cache utni der ke liye jitni der links zinda hain — na ek second zyada.
 * Sabse pehle marne wala link poore response ki umar tay karta hai.
 */
function cacheSeconds(data) {
  const MAX = 24 * 3600;
  let shortest = 0;

  for (const m of data.media || []) {
    const left = secondsUntilExpiry(m.url);
    if (left > 0 && (shortest === 0 || left < shortest)) shortest = left;
  }

  if (!shortest) return 3600; // expiry na mile to ek ghanta
  return Math.max(60, Math.min(MAX, shortest - 600)); // 10 min safety margin
}

// ---------------------------------------------------------------- download links
//
// Instagram ka CDN `Content-Disposition: attachment` nahi bhejta, isliye video
// download hone ki jagah browser me khul jaata hai. Cloudflare Worker beech me
// khada ho kar wo header laga deta hai.
//
// Worker ko signed link chahiye, warna wo ek open proxy ban jaata hai jise koi
// bhi apni bandwidth chalane ke liye use kar lega.
//
// ⚠️ SABSE ZAROORI BAAT: signature DETERMINISTIC honi chahiye.
// Ye poora JSON Vercel ke CDN me 24 ghante cache hota hai. Agar signature
// `Date.now()` se banti, to pehli request ki signature 24 ghante tak cache me
// chipak jaati aur ek ghante baad sabke download tootne lagte.
// Isliye expiry Instagram ke apne `oe=` param se leni hai — wo har baar same
// rehta hai, aur content ke saath hi natural taur par expire hota hai.

import { createHmac } from 'node:crypto';

const DOWNLOAD_SECRET = process.env.DOWNLOAD_SECRET || '';
const WORKER_URL = (process.env.WORKER_URL || '').replace(/\/+$/, '');

const DAY = 86400;

/** Signature ki expiry — hamesha wahi value, chahe kitni baar call ho */
function signExpiry(url) {
  const own = secondsUntilExpiry(url);
  if (own > 0) return Math.floor(Date.now() / 1000) + own; // Instagram ki apni expiry

  // `oe=` na mile to din ka bucket — ek pure din tak same value deta hai
  return (Math.floor(Date.now() / 1000 / DAY) + 2) * DAY;
}

function safeName(s, fallback) {
  const clean = String(s || '').replace(/[^A-Za-z0-9._-]/g, '');
  return clean || fallback;
}

/**
 * Har media item par download_url lagata hai.
 * Worker set na ho to seedha CDN link jaata hai (naye tab me khulega).
 */
function addDownloadLinks(data) {
  const user = safeName(data.username, 'instagram');
  const code = safeName(data.shortcode, 'media');
  const total = (data.media || []).length;

  /** Ek URL ko Worker ke through signed link me badalta hai */
  const via = (url, extra) => {
    const exp = signExpiry(url);
    const sig = createHmac('sha256', DOWNLOAD_SECRET).update(`${url}|${exp}`).digest('hex');
    return `${WORKER_URL}/?u=${encodeURIComponent(url)}&exp=${exp}&sig=${sig}&${extra}`;
  };

  const on = Boolean(WORKER_URL && DOWNLOAD_SECRET);

  const media = (data.media || []).map((m, i) => {
    const ext = m.type === 'video' ? 'mp4' : 'jpg';
    const filename = `${user}_${code}${total > 1 ? `_${i + 1}` : ''}.${ext}`;

    if (!on) {
      return { ...m, filename, download_url: m.url, media_url: m.url,
               thumb_url: m.thumb || null, forced: false };
    }

    return {
      ...m,
      filename,
      // attachment — browser file save karega
      download_url: via(m.url, `name=${encodeURIComponent(filename)}`),
      // inline — <img>/<video> me dikhane ke liye, download trigger nahi hota
      media_url: via(m.url, 'inline=1'),
      thumb_url: m.thumb ? via(m.thumb, 'inline=1') : null,
      forced: true,
    };
  });

  return {
    ...data,
    media,
    thumbnail_proxy: on && data.thumbnail_url ? via(data.thumbnail_url, 'inline=1') : data.thumbnail_url,
    audio_download_url: on && data.audio_url
      ? via(data.audio_url, `name=${encodeURIComponent(user + '_' + code + '.m4a')}`)
      : data.audio_url || null,
    forced_download: on,
  };
}

// ---------------------------------------------------------------- CORS
// '*' rakhoge to koi bhi site aapka API apne tool me laga legi — aapke
// session par, aapke risk par. Vercel env var ALLOWED_ORIGINS me apni site daalo.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function applyCors(req, res) {
  if (!ALLOWED_ORIGINS.length) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (ALLOWED_ORIGINS.includes(req.headers.origin)) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    // Origin cache key ka hissa ban jaata hai — isliye ek hi origin rakhna behtar
    res.setHeader('Vary', 'Origin');
  } else {
    // pehla origin default — direct browser visit / server-side calls ke liye
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0]);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
}

// ---------------------------------------------------------------- handler
export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  const shortcode = extractShortcode(req.query.url);
  if (!shortcode) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({
      error: 'Valid Instagram reel/post ka link bhejo',
      example: '/api/reel?url=https://www.instagram.com/reel/ABC123xyz/',
    });
  }

  const debug = req.query.debug === '1';
  const attempts = [];

  // --- guest cookies (ab cache se, har baar 616 KB nahi)
  let jar = {};
  let cookieInfo = null;
  try {
    const c = await getJar();
    jar = c.jar;
    cookieInfo = { cached: c.cached, ageSec: Math.round(c.ageMs / 1000), got: c.got || Object.keys(c.jar) };
  } catch (e) {
    cookieInfo = { error: `${e.name}: ${e.message}` };
  }

  // ⚠️ Kram soch-samajh kar hai, alphabetical ya purana nahi:
  //   web-api    — www ka darwaza. Test me chala. igexport bhi yahi use karte hain.
  //   mobile-api — app ka darwaza. Chalta hai, par logout_reason:33 yahin se aata tha.
  //   embed      — bina session ke bhi kabhi-kabhi chal jaata hai.
  //   graphql    — doc_id purana hone tak sabse aakhir me.
  const TIERS = [
    ['web-api', fromWebApi],
    ['mobile-api', fromMobileApi],
    ['embed', fromEmbed],
    ['graphql', fromGraphQL],
  ];

  /** Ek poora daur: saare tier ek-ek karke. Mil gaya to seedha bhej deta hai. */
  const runTiers = async () => {
    for (const [name, fn] of TIERS) {
      try {
        const r = await fn(shortcode, jar);
        const { ok, data, ...diag } = r;
        // status aur igMessage HAMESHA jaate hain — diagnose() ko production me
        // bhi inki zaroorat hai. Sirf raw body (`sample`) debug tak seemit hai.
        const { sample, htmlLength, ...safeDiag } = diag;
        attempts.push({ tier: name, ok, ...(debug ? diag : safeDiag) });
        if (ok) return data;
      } catch (e) {
        attempts.push({ tier: name, ok: false, reason: `${e.name}: ${e.message}` });
      }
    }
    return null;
  };

  let data = await runTiers();

  // Cookie cache ka ek khatra hai: purana csrftoken 30 minute tak chipka reh
  // sakta hai. Isliye agar saare tier fail hue AUR jar cache se aaya tha, to
  // ek baar taaza cookie lekar dobara koshish karo. Ye sirf tab chalta hai jab
  // pehle hi sab fail ho chuka ho — normal request par extra kharcha zero.
  if (!data && cookieInfo?.cached) {
    attempts.push({ tier: '(cookie refresh)', ok: false, reason: 'saare tier fail — taazi cookies leke dobara' });
    try {
      const c2 = await getJar(true);
      jar = c2.jar;
      cookieInfo = { cached: false, ageSec: 0, refreshed: true, got: c2.got || Object.keys(c2.jar) };
      data = await runTiers();
    } catch (e) {
      cookieInfo = { error: `${e.name}: ${e.message}`, refreshed: true };
    }
  }

  if (data) {
    if (debug) {
      // debug response cache hua to purana diagnostic data chipak jayega
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ ...addDownloadLinks(data), cookies: cookieInfo, attempts });
    }
    const ttl = cacheSeconds(data);
    res.setHeader('Cache-Control', `public, s-maxage=${ttl}, max-age=0`);
    res.setHeader('CDN-Cache-Control', `public, s-maxage=${ttl}`);
    return res.status(200).json(addDownloadLinks(data));
  }

  const verdict = diagnose(attempts, Boolean(SESSIONID));

  // Status soch-samajh kar chuna gaya hai, kyunki Vercel sirf
  // 200/404/410/301/302/307/308 cache karta hai — 502 kabhi cache nahi hota.
  //
  //   Reel hi nahi hai   -> 404, 10 min cache. Ek private reel par 500 log click
  //                         karein to Instagram ko sirf 1 baar poocha jayega.
  //   Humari taraf dikkat -> 502, koi cache nahi. Session theek karte hi turant
  //                          sahi chalne lagega, cache clear karne ki zaroorat nahi.
  const reelFault = Boolean(verdict.reelFault);

  if (debug) {
    res.setHeader('Cache-Control', 'no-store');
  } else if (reelFault) {
    res.setHeader('Cache-Control', 'public, s-maxage=600, max-age=0');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }

  return res.status( reelFault ? 404 : 502 ).json({
    error: reelFault ? 'Ye reel fetch nahi ho sakti' : 'Reel fetch nahi ho paayi',
    diagnosis: verdict.code,
    kya_hua: verdict.meaning,
    shortcode,
    docIdUsed: DOC_ID,
    hadSessionId: Boolean(SESSIONID),
    cookies: cookieInfo,
    attempts,
  });
}
