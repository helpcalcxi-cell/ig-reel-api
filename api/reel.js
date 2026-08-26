// ============================================================
//  Instagram Reel Downloader API  —  v3
//
//  v2 ka sabak: Instagram bina cookies ke sirf khaali web page deta hai.
//  Isliye ab pehle guest cookies (csrftoken) leke aate hain, phir data maangte hain.
//
//  Tier 1: GraphQL          (csrftoken ke saath)
//  Tier 2: Mobile API       (i.instagram.com — alag rasta, alag rules)
//  Tier 3: Embed page
//  Tier 4: Web API          (purana, ab shayad hi chale)
//
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

// ---------------------------------------------------------------- cookies

/**
 * Instagram se guest cookies leta hai (csrftoken, mid, ig_did).
 * Inke bina web endpoints sirf khaali page dete hain — v2 me yahi galti thi.
 */
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

function cookieHeader(jar) {
  const all = { ...jar };
  if (SESSIONID) all.sessionid = SESSIONID;
  return Object.entries(all)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
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

function pickBest(node) {
  if (node.video_url) return { type: 'video', url: clean(node.video_url) };

  if (node.video_versions?.length) {
    const best = [...node.video_versions].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    return { type: 'video', url: best.url, width: best.width, height: best.height };
  }
  if (node.display_url) return { type: 'image', url: clean(node.display_url) };

  const cands = node.image_versions2?.candidates || [];
  const best = [...cands].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return best ? { type: 'image', url: best.url, width: best.width, height: best.height } : null;
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
    caption: (m.edge_media_to_caption?.edges?.[0]?.node?.text || '').slice(0, 300),
    duration: m.video_duration || null,
    media,
  };
}

/** REST (v1) shape -> standard shape */
function fromRestItem(item, shortcode) {
  const nodes = item.carousel_media?.length ? item.carousel_media : [item];
  const media = nodes.map(pickBest).filter(Boolean);
  const firstVideo = media.find((x) => x.type === 'video');

  return {
    shortcode: item.code || shortcode,
    is_video: Boolean(firstVideo),
    video_url: firstVideo?.url || null,
    thumbnail_url: item.image_versions2?.candidates?.[0]?.url || null,
    username: item.user?.username || null,
    caption: (item.caption?.text || '').slice(0, 300),
    duration: item.video_duration || null,
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
    return { ok: false, reason: `graphql HTTP ${res.status}`, status: res.status, sample: text.slice(0, 400) };
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
  if (SESSIONID) headers.Cookie = `sessionid=${SESSIONID}`;

  const res = await fetch(`https://i.instagram.com/api/v1/media/${mediaId}/info/`, { headers });
  const text = await res.text();

  if (looksLikeHtml(text)) {
    return { ok: false, reason: `mobile api ne HTML bheja (status ${res.status})`, status: res.status, sample: text.slice(0, 250) };
  }
  if (!res.ok) {
    return { ok: false, reason: `mobile api HTTP ${res.status}`, status: res.status, sample: text.slice(0, 300) };
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
    return { ok: false, reason: `web api ne HTML bheja (status ${res.status})`, status: res.status };
  }
  if (!res.ok) return { ok: false, reason: `web api HTTP ${res.status}`, status: res.status, sample: text.slice(0, 250) };

  let json;
  try { json = JSON.parse(text); }
  catch { return { ok: false, reason: 'web api JSON parse fail', status: res.status, sample: text.slice(0, 250) }; }

  const item = json?.items?.[0];
  if (!item) {
    return { ok: false, reason: 'web api me items nahi mile', status: res.status, igMessage: json?.message || null };
  }

  return { ok: true, data: { source: 'web-api', ...fromRestItem(item, shortcode) } };
}

// ---------------------------------------------------------------- handler
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const shortcode = extractShortcode(req.query.url);
  if (!shortcode) {
    return res.status(400).json({
      error: 'Valid Instagram reel/post ka link bhejo',
      example: '/api/reel?url=https://www.instagram.com/reel/ABC123xyz/',
    });
  }

  const debug = req.query.debug === '1';
  const attempts = [];

  // --- pehle guest cookies
  let jar = {};
  let cookieInfo = null;
  try {
    const c = await getGuestCookies();
    jar = c.jar;
    cookieInfo = { status: c.status, got: c.got };
  } catch (e) {
    cookieInfo = { error: `${e.name}: ${e.message}` };
  }

  const TIERS = [
    ['graphql', fromGraphQL],
    ['mobile-api', fromMobileApi],
    ['embed', fromEmbed],
    ['web-api', fromWebApi],
  ];

  for (const [name, fn] of TIERS) {
    try {
      const r = await fn(shortcode, jar);
      const { ok, data, ...diag } = r;
      attempts.push({ tier: name, ok, ...(debug ? diag : { reason: diag.reason }) });
      if (ok) return res.status(200).json(debug ? { ...data, cookies: cookieInfo, attempts } : data);
    } catch (e) {
      attempts.push({ tier: name, ok: false, reason: `${e.name}: ${e.message}` });
    }
  }

  return res.status(502).json({
    error: 'Reel fetch nahi ho paayi',
    hint: 'Anonymous access band ho sakta hai. sessionid (IG_SESSIONID env var) se try karo.',
    shortcode,
    docIdUsed: DOC_ID,
    hadSessionId: Boolean(SESSIONID),
    cookies: cookieInfo,
    attempts,
  });
}
