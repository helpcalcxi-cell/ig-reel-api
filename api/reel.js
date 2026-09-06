// ============================================================
//  Instagram Reel Downloader API  —  v9.7
//
//  v9.7: age gate milte hi baaki saare tier band. v9.6 ne verdict sahi diya
//  tha par live par 5.7 second lag rahe the kyunki session tier, cookie
//  refresh aur dobara koshish sab chalte rehte the — jabki jawab pehle hi
//  tier me saaf tha. Ab wahi jawab ~1.5 second me.
//
//  v9.6 me kya aaya tha:
//
//  1. AGE GATE PEHCHANA JAATA HAI. Jo post age-restricted hai uska page 200 OK
//     aur 650+ KB aata hai par media hata hua hota hai. Pehle ye "app shell"
//     lagta tha, yaani hamari galti — 502, koi cache nahi, aur ek Apify call
//     jo waise bhi fail hoti. Ab ye 404 hai, 10 minute cache ke saath, aur
//     user ko saaf message milta hai.
//
//  2. SHARE TOKEN (stkn / igsh) ab phenka nahi jaata. Saaf URL pehle, aur
//     girne par ek baar token ke saath. Age gate par ye retry chalta hi nahi,
//     kyunki test me saabit ho gaya ki token us deewar ko nahi kholta.
//
//  v9.5 se: control probe (galti kiski hai, ye pata karne ke liye), 7 second
//  ka tier budget, aur saare user-facing message English me.
//
//  v9 KI BADI BAAT: ab zyadatar reels ke liye INSTAGRAM ACCOUNT CHAHIYE HI NAHI.
//
//  Aayush ne incognito me (bina login ke) reel kholi aur DevTools me
//  `video_versions` search kiya. Vo seedha `/reel/{shortcode}/` ke HTML ke
//  andar mila. Pehle `.mp4` search kiya tha aur kuch nahi mila — kyunki JSON me
//  har slash escape hota hai (`https:\/\/`), isliye ye cheez chhupi rahi.
//
//  Hamare saare purane tier API endpoints par jaate the. PAGE kabhi fetch hi
//  nahi kiya tha. Test me vo bina session ke, Vercel ke apne IP se chal gaya —
//  reel, photo, aur 5-slide carousel, teeno.
//
//  ⚠️ Par ye har baar nahi chalta. Kuch Vercel IP flagged hain: unse wahi
//     khaali 492 KB ka page aata hai. Isliye purane tier hataye NAHI gaye —
//     ve peeche backup me khade hain, sessionid ke saath.
//
//  v8 wale do badlaav bhi bane hue hain:
//
//  1. TIER KA KRAM
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
//  Tier 1: Reel page   (/reel/{code}/ — BINA session. Chal gaya to cookies tak
//                       nahi mangwate, kyunki page ko unki zarurat hi nahi.)
//  Tier 2: Web API     (www.instagram.com — session ke saath)
//  Tier 3: Mobile API  (i.instagram.com — session ke saath)
//  Tier 4: Embed page
//  Tier 5: GraphQL     (⚠️ doc_id purana hai, "execution error" deta hai —
//                       isliye aakhir me. Naya doc_id mile to IG_DOC_ID env
//                       var me daal dena.)
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

// Vercel Hobby ka function 10 second me kat jaata hai. Ek atki hui request
// poora budget kha leti hai aur baaki tier chalte hi nahi — isliye har fetch
// ki apni seema. 4 tier x 6s worst case bhi budget ke andar hai kyunki pehla
// chal jane par baaki chalte hi nahi.
const FETCH_TIMEOUT = 6000;

// Poore tier-kaam ka total budget. Har fetch ki apni seema hai, par jab har
// tier girta hai to woh seemayein jud kar 8-9 second bana deti hain. Vercel
// ka function usse thoda hi upar katta hai, aur user ke liye 8 second wait
// karke error dekhna sabse bura anubhav hai. Isliye ek chhatri deadline.
const TIER_BUDGET_MS = 7000;

// Ek tier chalane layak kam se kam waqt. Isse kam bacha ho to nayi koshish
// shuru karne ka matlab nahi — woh sirf budget khayegi aur adhoori maregi.
const MIN_TIER_MS = 1500;

// Aakhri kaamyaab request ka waqt. Ye is instance ki yaad hai, aur iska ek
// hi kaam hai: fail hone par ye batana ki galti kiski hai.
//
//   Abhi kisi aur reel ko theek serve kiya tha  -> hamara IP/session theek hai,
//                                                  to YE reel hi private/deleted hai -> 404
//   Kaafi der se kuch bhi serve nahi hua        -> shayad hamari taraf dikkat hai -> 502
//
// 404 cache hota hai aur Apify fallback ko nahi bulata. 502 nahi hota aur
// bulata hai. Isliye ye farak seedha paise aur speed par asar daalta hai.
let lastSuccessAt = 0;
const RECENT_SUCCESS_MS = 5 * 60 * 1000;

// lastSuccessAt akela kaafi NAHI hai, aur wajah samajhna zaroori hai:
// kaamyaab jawab CDN par cache hote hain (s-maxage), isliye woh dobara
// function tak pahunchte hi nahi. Vercel kai instance chalata hai, to ek
// naye instance ki yaad khaali hoti hai aur woh har fail par 502 de deta.
// Live par yahi "hamesha Apify par chala jaata hai" jaisa dikhta hai.
//
// Isliye asli faisla ek control post se hota hai. Jab sab fail ho jaye, to
// ek aisi post maango jo hamesha public hai:
//
//   control mil gayi   -> hamara IP theek hai -> jo post maangi thi WAHI gayab hai -> 404
//   control bhi nahi   -> hamari taraf dikkat hai -> 502 -> Apify sambhale
//
// Ye instance ki yaad par nirbhar nahi hai, isliye har jagah ek jaisa chalta hai.
const CONTROL_SHORTCODE = process.env.IG_CONTROL_SHORTCODE || 'DbdoGAQMg8O';
const CONTROL_TTL_MS = 60 * 1000;
const CONTROL_TIMEOUT_MS = 2500;
let controlProbe = { at: 0, ok: false };

/** Kya Instagram is server se abhi baat kar raha hai? Jawab 60s cache hota hai. */
async function ipLooksHealthy() {
  if (controlProbe.at && Date.now() - controlProbe.at < CONTROL_TTL_MS) return controlProbe.ok;
  let ok = false;
  try {
    const r = await fromReelPage(CONTROL_SHORTCODE, CONTROL_TIMEOUT_MS);
    ok = Boolean(r && r.ok);
  } catch { ok = false; }
  controlProbe = { at: Date.now(), ok };
  return ok;
}

// In verdicts ka matlab "post hi nahi mili" ho sakta hai. RATE_LIMITED,
// CHALLENGE aur SESSION_KILLED jaan-bujh kar bahar hain — woh saaf taur par
// hamari taraf ki dikkat hain aur unme Apify fallback chalna hi chahiye.
const POST_LIKELY_CODES = new Set(['NEED_LOGIN', 'SESSION_REJECTED', 'APP_SHELL', 'UNKNOWN']);

// v9.6 — AGE GATE
// Aayush ne `Dc8DvIXgZA_` ko do URL se khola: saada URL, aur share button
// wala `stkn` URL. Dono par Instagram ne likha:
//   "Age-restricted content — This content is age-restricted based on your
//    age or account settings. Log in to continue."
// Yahi wajah thi ki us post ka page 200 OK aur 658 KB aata tha par uske andar
// `video_versions` tha hi nahi. Post public hai, media jaan-bujh kar hataya
// gaya hai. Bina logged-in adult account ke ye kabhi nahi milega — na hamare
// tier se, na Apify se. Isliye ise pehchan kar seedha 404 dena hi sahi hai:
// user ko sach pata chalta hai, aur ek bekaar Apify call bachti hai.
//
// ⚠️ Ye check SIRF failure ke raste par chalta hai. Normal page ke JSON me
//    `"is_age_restricted":false` aata hai, aur agar ise success par bhi
//    chalate to wo false positive de sakta tha.
const AGE_GATE_RE =
  /Age-restricted content|restricted based on your age|"is_age_restricted"\s*:\s*true|age_restricted_content/i;

// Kuch halaat me hum pakke taur par jaante hain ki hua kya — un par user ko
// gol-mol jawab dena bekaar hai. Baaki sab aam jawab par girte hain.
const USER_ERROR = {
  AGE_RESTRICTED: 'This post is age restricted on Instagram, so it cannot be downloaded without logging in',
  REEL_NOT_FOUND: 'This post is private, has been deleted, or the link is wrong',
};

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

/**
 * v9.6 — share token.
 *
 * Instagram app ka "Copy link" aur web ka share button aise URL dete hain:
 *   /reel/ABC/?utm_source=ig_web_copy_link&stkn=NTc4...
 *   /reel/ABC/?igsh=MWx5...
 *
 * Ab tak hum ye token phenk dete the aur hamesha saaf URL maangte the.
 * Test se pata chala ki age-restricted post ko token bhi nahi kholta — par
 * baaki halaat me ye ek muft mauka hai, aur hamare bahut se user waise hi
 * app se copy kiya hua tokenised link paste karte hain.
 *
 * Isliye token ka istemaal RETRY ki tarah hota hai, pehli koshish ki tarah
 * nahi: saaf URL pehle (uska CDN cache sab users me saanjha rehta hai), aur
 * girne par ek baar token ke saath.
 */
function extractShareToken(input) {
  if (!input) return null;
  const m = String(input).match(/[?&](stkn|igsh)=([A-Za-z0-9._\-=%]{4,200})/i);
  if (!m) return null;
  let value = m[2];
  try { value = decodeURIComponent(value); } catch { /* jaisa hai waisa hi rehne do */ }
  if (!value || value.length > 200) return null;
  return { name: m[1].toLowerCase(), value };
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
/** fetch ki asli wajah — `TypeError: fetch failed` ke peeche kya hai */
function causeOf(e) {
  const c = e?.cause;
  if (!c) return e?.name === 'TimeoutError' ? `no response within ${FETCH_TIMEOUT}ms` : undefined;
  return [c.code, c.message].filter(Boolean).join(' — ') || String(c);
}

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
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
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

  // Sabse pehle age gate — kyunki ye sabse pakka jawab hai. Page 200 aata hai,
  // bhaari hota hai, par media hataya hua hota hai. Isme na hamara IP kharab
  // hai na session, isliye control probe chalane ka bhi matlab nahi.
  if (attempts.some((a) => a.ageRestricted)) {
    return {
      code: 'AGE_RESTRICTED',
      meaning:
        'Instagram has marked this post as age restricted and only serves it to logged in adult accounts, so it cannot be downloaded anonymously.',
      reelFault: true,
    };
  }

  // Reel khud hi nahi hai (private/deleted) — ye humari galti nahi hai.
  // Ise alag pehchanna zaroori hai kyunki iska HTTP status alag hota hai (neeche dekho).
  if (attempts.some((a) => a.status === 404) && !/login_required|require_login|challenge/i.test(blob)) {
    return {
      code: 'REEL_NOT_FOUND',
      meaning: 'This post is private, has been deleted, or the link is wrong.',
      reelFault: true,
    };
  }

  if (/challenge_required|checkpoint_required/i.test(blob)) {
    return {
      code: 'CHALLENGE',
      meaning: 'Instagram has put a verification challenge on the account. It will no longer work from this server and needs replacing.',
    };
  }
  if (/logout_reason|You.{0,3}ve Been Logged Out/i.test(blob) && hasSession) {
    return {
      code: 'SESSION_KILLED',
      meaning: 'The sessionid is dead. The account was banned or Instagram logged it out.',
    };
  }
  if (/login_required|require_login/i.test(blob)) {
    return hasSession
      ? {
          code: 'SESSION_REJECTED',
          meaning: 'The sessionid was rejected. It was copied wrong, has expired, or was refused because of the server IP.',
        }
      : {
          code: 'NEED_LOGIN',
          meaning: 'The reel-page tier failed and there is no sessionid. Either this server IP is flagged, which often clears on its own, or IG_SESSIONID needs to be set.',
        };
  }
  if (/Please wait a few minutes|rate.?limit|Try again later/i.test(blob)) {
    return {
      code: 'RATE_LIMITED',
      meaning: 'The server IP has been rate limited. It may clear shortly, but the real fix is a residential proxy.',
    };
  }
  if (/isAppShell":true/.test(blob)) {
    return {
      code: 'APP_SHELL',
      meaning: 'Instagram returned an empty app shell instead of data, meaning it is treating this server as a logged out visitor.',
    };
  }
  return { code: 'UNKNOWN', meaning: 'Not recognised. Send the full attempts output for diagnosis.' };
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
    const sorted = [...node.video_versions]
      .filter((v) => v && v.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    const best = sorted[0];

    // Instagram ek hi video ki kai quality bhejta hai (720p, 480p, 320p).
    // v9.2 tak hum sirf sabse achhi rakh kar baaki phenk dete the. Ab saari
    // bahar jaati hain taki user khud chun sake. Ek hi width do baar aa jaye
    // to pehli hi rakhte hain, warna dropdown me "720p, 720p" dikhega.
    const seen = new Set();
    const variants = [];
    for (const v of sorted) {
      const w = v.width || 0, h = v.height || 0;
      const p = w && h ? Math.min(w, h) : (w || h || 0);
      if (!p || seen.has(p)) continue;
      seen.add(p);
      variants.push({ url: v.url, width: w || null, height: h || null, label: p + 'p' });
    }

    return {
      type: 'video',
      url: best.url,
      width: best.width,
      height: best.height,
      thumb: poster,
      ...(variants.length > 1 ? { variants } : {}),
    };
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


// ---------------------------------------------------------------- TIER: reel page
//
// Ye page ke andar chhupa hua JSON padhta hai. Faayda ye hai ki us JSON ka
// dhaancha bilkul wahi hai jo mobile/web API deta hai — isliye seedha
// fromRestItem() me daal dete hain aur audio, likes, views, duration, aur
// carousel ke har slide ka apna thumbnail — sab muft me mil jaata hai.

const STATIC_ASSET = /static\.cdninstagram\.com|\/rsrc\.php\//i;

/**
 * Kya ye sach me media hai, ya Instagram ke UI ka koi icon?
 *
 * ⚠️ Ye check hone se pehle ek galat version ne `og:image` se Instagram ka
 *    apna logo utha kar "mil gaya" bol diya tha, jabki page bilkul khaali tha.
 *    Isliye host ki jaanch ab pehle hoti hai.
 */
function isRealMedia(u) {
  if (typeof u !== 'string' || !u) return false;
  if (!/(?:cdninstagram\.com|fbcdn\.net)/i.test(u)) return false;
  return !STATIC_ASSET.test(u);
}

function jsonBlobs(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { out.push(JSON.parse(m[1])); } catch { /* har blob JSON nahi hota */ }
  }
  return out;
}

/**
 * Gehraai me ja kar media item dhoondhta hai. Instagram ka JSON bahut ghont kar
 * rakha hota hai, seedha rasta nahi hota. `code` milne wala item sabse behtar.
 */
function findMediaItem(node, shortcode, depth = 0, best = { exact: null, any: null }) {
  if (!node || typeof node !== 'object' || depth > 40) return best;
  if (Array.isArray(node)) {
    for (const x of node) findMediaItem(x, shortcode, depth + 1, best);
    return best;
  }
  if (node.video_versions || node.carousel_media || node.image_versions2) {
    if (node.code === shortcode && !best.exact) best.exact = node;
    else if (!best.any) best.any = node;
  }
  for (const k of Object.keys(node)) findMediaItem(node[k], shortcode, depth + 1, best);
  return best;
}

/** Item me kam se kam ek asli media URL hai ya nahi */
function hasUsableMedia(item) {
  const nodes = item.carousel_media?.length ? item.carousel_media : [item];
  return nodes.some((n) =>
    n.video_versions?.some((v) => isRealMedia(v?.url)) ||
    n.video_url && isRealMedia(n.video_url) ||
    (n.image_versions2?.candidates || []).some((c) => isRealMedia(c?.url)) ||
    (n.display_url && isRealMedia(n.display_url))
  );
}


/**
 * Video URL ke `efg` param me duration chhupi hoti hai.
 *
 * Page wale JSON me `video_duration` nahi aata, par CDN link ke andar base64
 * me ye likha hota hai: {"duration_s":22,"urlgen_source":"www",...}
 * Ye wahi jagah hai jahan se pehle pata chala tha ki igexport bhi `www` use
 * karte hain.
 */
function durationFromUrl(url) {
  try {
    const efg = new URL(url).searchParams.get('efg');
    if (!efg) return null;
    const j = JSON.parse(Buffer.from(efg, 'base64').toString('utf8'));
    return typeof j.duration_s === 'number' ? j.duration_s : null;
  } catch {
    return null;
  }
}

const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * XML wali escaping kholta hai.
 *
 * ⚠️ Ye zaroori hai aur iski wajah asli hai: DASH manifest XML hai, aur XML me
 *    har `&` `&amp;` likha jaata hai. Bina isko kholе audio link aisa jaata tha:
 *        ...mp4?_nc_cat=105&amp;_nc_sid=9ca052&amp;oe=6A9CB076
 *    Instagram aise params nahi pehchanta — download toot jaata. Aur `oe` ka
 *    naam `amp;oe` ban jaata, isliye link ki asli expiry bhi nahi mil paati thi.
 *
 * Ek hi pass me badalta hai, warna `&amp;lt;` do baar khul kar `<` ban jata.
 */
function decodeXmlEntities(str) {
  return str.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (whole, key) =>
    key.startsWith('#') ? String.fromCharCode(Number(key.slice(1))) : (XML_ENT[key] ?? whole)
  );
}

/**
 * DASH manifest me audio ka alag track hota hai. Page me ye `video_dash_manifest`
 * ke naam se milta hai — wahi `MPD` jo DevTools search me dikha tha.
 */
function audioFromDash(manifest) {
  if (typeof manifest !== 'string' || !manifest) return null;
  const m = manifest.match(/mimeType="audio\/mp4"[\s\S]{0,4000}?<BaseURL>([^<]+)<\/BaseURL>/i);
  if (!m) return null;
  const url = decodeXmlEntities(clean(m[1].trim()));
  return isRealMedia(url) ? url : null;
}

async function fromReelPage(shortcode, timeoutMs = FETCH_TIMEOUT, token = null) {
  // Token wala URL bilkul waisa banate hain jaisa Instagram ka apna share
  // button deta hai — utm_source ke saath — taki request unke liye normal lage.
  const qs = token
    ? `?utm_source=ig_web_copy_link&${token.name}=${encodeURIComponent(token.value)}`
    : '';

  const res = await fetch(`https://www.instagram.com/reel/${shortcode}/${qs}`, {
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
    headers: {
      // Asli browser ka NAVIGATION jaisa. Baaki tier XHR jaise headers bhejte
      // hain, jo Instagram ko bilkul alag dikhte hain.
      'User-Agent': UA_WEB,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1',
      'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      // ⚠️ Yahan koi Cookie nahi — na guest, na session. Yahi is tier ki jaan hai.
    },
  });

  const html = await res.text();
  const facts = { htmlLength: html.length, hasVideoVersions: html.includes('video_versions') };

  if (!res.ok) return { ok: false, reason: `reel page HTTP ${res.status}`, status: res.status, ...facts };

  let item = null;
  for (const blob of jsonBlobs(html)) {
    const f = findMediaItem(blob, shortcode);
    item = f.exact || f.any;
    if (item) break;
  }

  if (item && hasUsableMedia(item)) {
    const out = fromRestItem(item, shortcode);

    // Page ka JSON API se thoda kam deta hai — jo chhoot gaya, wo doosri jagah
    // se bhar lete hain. Jo phir bhi na mile, use null hi rehne dete hain;
    // jhoothi value bharne se bura kuch nahi.
    if (out.duration == null) out.duration = durationFromUrl(out.video_url || '');
    if (!out.audio_url) out.audio_url = audioFromDash(item.video_dash_manifest);
    if (out.views == null) {
      out.views = item.play_count ?? item.view_count ?? item.video_view_count ??
                  item.ig_play_count ?? item.media_overlay_info?.play_count ?? null;
    }

    return { ok: true, data: { source: 'reel-page', ...out } };
  }

  // Ab jab media nahi mila, tabhi age gate dekhte hain. Success ke raste par
  // ye kabhi nahi chalta, isliye `"is_age_restricted":false` wala false
  // positive ho hi nahi sakta.
  const ageRestricted = AGE_GATE_RE.test(html);

  return {
    ok: false,
    status: res.status,
    reason: ageRestricted
      ? 'the reel page loaded but Instagram replaced the media with an age restriction notice'
      : facts.hasVideoVersions
        ? 'the reel page carried media data but it could not be parsed'
        : 'the reel page came back without media, so Instagram treated this server as a logged out visitor',
    ...facts,
    ageRestricted,
    // Age gate ek asli page hai jisme se media hataya gaya hai — app shell
    // nahi. Dono ko alag rakhna zaroori hai, kyunki app shell hamari galti
    // hoti hai aur age gate post ki apni baat.
    isAppShell: !ageRestricted && html.length > 300000 && !facts.hasVideoVersions,
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
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
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
    return { ok: false, reason: `graphql returned HTML instead of JSON (status ${res.status}); cookies or doc_id did not work`, status: res.status, sample: text.slice(0, 300) };
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
      reason: 'graphql returned a null media object; the doc_id may be out of date',
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

  const res = await fetch(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  const text = await res.text();

  if (looksLikeHtml(text)) {
    return { ok: false, reason: `mobile api returned HTML instead of JSON (status ${res.status})`, status: res.status, sample: text.slice(0, 250) };
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
      reason: 'mobile api response had no items',
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
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
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
      reason: 'embed page had no media',
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
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
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
      reason: `web api returned HTML instead of JSON (status ${res.status})`,
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
    return { ok: false, reason: 'web api response had no items', status: res.status, igMessage: json?.message || null };
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
      return {
        ...m, filename, download_url: m.url, media_url: m.url,
        thumb_url: m.thumb || null, forced: false,
        ...(m.variants?.length
          ? { variants: m.variants.map((v) => ({ ...v, download_url: v.url, media_url: v.url })) }
          : {}),
      };
    }

    // Har quality ka apna signed link. Bina iske dropdown se quality badalne par
    // link sign hi nahi hoti aur Worker use reject kar deta.
    const variants = (m.variants || []).map((v) => ({
      label: v.label,
      width: v.width,
      height: v.height,
      download_url: via(v.url, `name=${encodeURIComponent(filename)}`),
      media_url: via(v.url, 'inline=1'),
    }));

    return {
      ...m,
      filename,
      ...(variants.length ? { variants } : {}),
      // attachment: browser file save karega
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
    // Cover ka DOWNLOAD wala link. thumbnail_proxy inline hai, vo browser me
    // khul jata hai; save karne ke liye `name=` wala alag link chahiye.
    cover_download_url: on && data.thumbnail_url
      ? via(data.thumbnail_url, `name=${encodeURIComponent(user + '_' + code + '_cover.jpg')}`)
      : data.thumbnail_url || null,
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

  const startedAt = Date.now();
  const timeLeft = () => TIER_BUDGET_MS - (Date.now() - startedAt);

  const shortcode = extractShortcode(req.query.url);
  if (!shortcode) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({
      error: 'Send a valid Instagram reel or post link',
      example: '/api/reel?url=https://www.instagram.com/reel/ABC123xyz/',
    });
  }

  const debug = req.query.debug === '1';
  const shareToken = extractShareToken(req.query.url);
  const attempts = [];

  // --- Tier 0: reel page. Ise cookies chahiye hi NAHI, isliye sabse pehle
  //     chalta hai aur cookie bootstrap se PEHLE. Chal gaya to us 616 KB wale
  //     homepage ko chhuna hi nahi padta — na data lagta, na waqt.
  let data = null;
  let cookieInfo = null;
  let jar = {};

  try {
    const r = await fromReelPage(shortcode);
    const { ok, data: d, ...diag } = r;
    const { sample, htmlLength, ...safeDiag } = diag;
    attempts.push({ tier: 'reel-page', ok, ...(debug ? diag : safeDiag) });
    if (ok) data = d;
  } catch (e) {
    attempts.push({ tier: 'reel-page', ok: false, reason: `${e.name}: ${e.message}`, cause: causeOf(e) });
  }

  // Saaf URL gira aur user ke link me share token tha — ek baar token ke saath.
  // Age gate par ye chhod dete hain: test me saabit ho chuka hai ki token us
  // deewar ko nahi kholta, to us par 2 second aur kharch karne ka koi matlab
  // nahi.
  // v9.7 — jaise hi age gate dikha, sab kuch band.
  //
  // v9.6 ne verdict to sahi diya par baaki tier phir bhi chalte rahe: live par
  // 5.7 second lage, jabki jawab pehle hi tier me saaf tha. Age gate ka matlab
  // hai ki Instagram ne khud bataya ki media logged-in adult account ke bina
  // milega hi nahi. Us haal me session tier, cookie refresh, dobara koshish —
  // sab sirf waqt aur data kharch karte hain, nateeja wahi rehta hai.
  const ageGate = () => attempts.some((a) => a.ageRestricted);

  if (!data && shareToken && !ageGate() && timeLeft() >= MIN_TIER_MS) {
    try {
      const r = await fromReelPage(shortcode, FETCH_TIMEOUT, shareToken);
      const { ok, data: d, ...diag } = r;
      const { sample, htmlLength, ...safeDiag } = diag;
      attempts.push({ tier: `reel-page+${shareToken.name}`, ok, ...(debug ? diag : safeDiag) });
      if (ok) data = d;
    } catch (e) {
      attempts.push({ tier: `reel-page+${shareToken.name}`, ok: false, reason: `${e.name}: ${e.message}`, cause: causeOf(e) });
    }
  }

  // ⚠️ Kram soch-samajh kar hai:
  //   reel-page  — bina account. Zyadatar yahin kaam ho jaata hai.
  //   web-api    — www ka darwaza, session ke saath. igexport bhi yahi use karte hain.
  //   mobile-api — app ka darwaza. Chalta hai, par logout_reason:33 yahin se aata tha.
  //   embed      — kabhi-kabhi bina session ke bhi chal jaata hai.
  //   graphql    — doc_id purana hone tak sabse aakhir me.
  const TIERS = [
    ['web-api', fromWebApi],
    ['mobile-api', fromMobileApi],
    ['embed', fromEmbed],
    ['graphql', fromGraphQL],
  ];

  /** Baaki tier — inhe cookies chahiye, isliye ye reel-page ke girne par hi chalte hain. */
  const runTiers = async () => {
    for (const [name, fn] of TIERS) {
      if (timeLeft() < MIN_TIER_MS) {
        attempts.push({ tier: name, ok: false, reason: `time budget spent (${timeLeft()}ms left), tier skipped` });
        continue;
      }
      try {
        const r = await fn(shortcode, jar);
        const { ok, data: d, ...diag } = r;
        // status aur igMessage HAMESHA jaate hain — diagnose() ko production me
        // bhi inki zaroorat hai. Sirf raw body (`sample`) debug tak seemit hai.
        const { sample, htmlLength, ...safeDiag } = diag;
        attempts.push({ tier: name, ok, ...(debug ? diag : safeDiag) });
        if (ok) return d;
      } catch (e) {
        // `TypeError: fetch failed` apne aap me kuch nahi batata — asli wajah
        // (connection reset, DNS, timeout) e.cause me hoti hai. Use bahar
        // nikalna zaroori hai, warna har network dikkat ek jaisi dikhti hai.
        attempts.push({ tier: name, ok: false, reason: `${e.name}: ${e.message}`, cause: causeOf(e) });
      }
    }
    return null;
  };

  // reel-page gira — ab cookies lao aur baaki tier chalao
  if (!data && !ageGate()) {
    try {
      const c = await getJar();
      jar = c.jar;
      cookieInfo = { cached: c.cached, ageSec: Math.round(c.ageMs / 1000), got: c.got || Object.keys(c.jar) };
    } catch (e) {
      cookieInfo = { error: `${e.name}: ${e.message}` };
    }
    data = await runTiers();
  }

  // Cookie cache ka ek khatra hai: purana csrftoken 30 minute tak chipka reh
  // sakta hai. Isliye agar saare tier fail hue AUR jar cache se aaya tha, to
  // ek baar taaza cookie lekar dobara koshish karo. Ye sirf tab chalta hai jab
  // pehle hi sab fail ho chuka ho — normal request par extra kharcha zero.
  if (!data && !ageGate() && cookieInfo?.cached && timeLeft() >= MIN_TIER_MS) {
    attempts.push({ tier: '(cookie refresh)', ok: false, reason: 'all tiers failed, retrying once with fresh cookies' });
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
    lastSuccessAt = Date.now();
    if (debug) {
      // debug response cache hua to purana diagnostic data chipak jayega
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        ...addDownloadLinks(data), cookies: cookieInfo, attempts,
        tookMs: Date.now() - startedAt,
      });
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
  //
  // Private reel yahan pehle 502 ban rahi thi. Wajah: bina session ke baaki
  // tier `login_required` dete hain, aur diagnose() ka pehla check us shabd
  // par jaan-bujh kar ruk jaata hai (kyunki login_required ka matlab hamara
  // session marna bhi ho sakta hai). Nateeja: har private reel par 8 second
  // ka intezaar, ek bekaar Apify call, aur user ko "service is busy" — jabki
  // asli baat sirf itni thi ki woh reel private hai.
  //
  // Farak karne ka tareeka: agar isi instance ne abhi-abhi kisi aur reel ko
  // theek serve kiya hai, to hamara IP aur session dono theek hain. Us haal
  // me is reel ka na milna is reel ki apni baat hai, hamari nahi.
  const couldBePost = POST_LIKELY_CODES.has(verdict.code);
  const servedRecently = lastSuccessAt > 0 && (Date.now() - lastSuccessAt) < RECENT_SUCCESS_MS;

  // Pehle muft wala check: isi instance ne abhi kuch serve kiya ho to probe
  // ki zaroorat hi nahi. Warna control post maang kar dekho.
  let healthy = servedRecently;
  let how = servedRecently ? 'recent-success' : null;
  if (!healthy && couldBePost && timeLeft() >= CONTROL_TIMEOUT_MS) {
    healthy = await ipLooksHealthy();
    how = healthy ? 'control-probe' : null;
  }

  const reelFault = Boolean(verdict.reelFault) || (healthy && couldBePost);

  if (debug) {
    res.setHeader('Cache-Control', 'no-store');
  } else if (reelFault) {
    res.setHeader('Cache-Control', 'public, s-maxage=600, max-age=0');
  } else {
    res.setHeader('Cache-Control', 'no-store');
  }

  return res.status( reelFault ? 404 : 502 ).json({
    // Jahan hum pakke hain wahan seedha bata dete hain, warna aam jawab.
    // Jhooth se bachne ke liye: "private ya deleted" tabhi likha jaata hai jab
    // verdict wahi kehta ho, guess par nahi.
    error: USER_ERROR[verdict.code]
      || (reelFault ? 'This post could not be fetched' : 'Could not fetch this post right now'),
    diagnosis: verdict.code,
    whatHappened: verdict.meaning,
    shortcode,
    blamedOn: reelFault ? (verdict.reelFault ? 'verdict' : how) : 'our-side',
    shareToken: shareToken ? shareToken.name : null,
    tookMs: Date.now() - startedAt,
    docIdUsed: DOC_ID,
    hadSessionId: Boolean(SESSIONID),
    cookies: cookieInfo,
    attempts,
  });
}
