// ============================================================
//  Instagram Reel Downloader API  —  v2
//
//  Tier 1: GraphQL  (ab yahi asli tarika hai — doc_id chahiye)
//  Tier 2: Embed page
//  Tier 3: media/info API
//
//  Test:  /api/reel?url=<reel link>
//  Debug: /api/reel?url=<reel link>&debug=1   <- fail hone par yahi bhejna
// ============================================================

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const IG_APP_ID = '936619743392459';

// ⚠️ Instagram ye har 2-4 hafte badalta hai. Jab sab kuch achanak fail hone lage,
// sabse pehle ISE badlo — code nahi. Vercel env var IG_DOC_ID se bhi set kar sakte ho.
const DOC_ID = process.env.IG_DOC_ID || '8845758582119845';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

function baseHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    'sec-ch-ua': '"Chromium";v="131", "Not_A Brand";v="24"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    ...extra,
  };
}

/** Har media node ko ek hi shape me badalta hai */
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

// ---------------------------------------------------------------- TIER 1
// GraphQL — 2026 me yahi chalta hai. doc_id upar constant me hai.
async function fromGraphQL(shortcode) {
  const body = new URLSearchParams({
    variables: JSON.stringify({
      shortcode,
      fetch_tagged_user_count: null,
      hoisted_comment_id: null,
      hoisted_reply_id: null,
    }),
    doc_id: DOC_ID,
  });

  const res = await fetch('https://www.instagram.com/graphql/query', {
    method: 'POST',
    headers: baseHeaders({
      'x-ig-app-id': IG_APP_ID,
      'content-type': 'application/x-www-form-urlencoded',
      Accept: '*/*',
      Origin: 'https://www.instagram.com',
      Referer: `https://www.instagram.com/reel/${shortcode}/`,
    }),
    body,
  });

  const text = await res.text();
  if (!res.ok) return { ok: false, reason: `graphql HTTP ${res.status}`, status: res.status, sample: text.slice(0, 500) };

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'graphql ne JSON nahi bheja (login wall?)', status: res.status, sample: text.slice(0, 500) };
  }

  const m = json?.data?.xdt_shortcode_media || json?.data?.shortcode_media;
  if (!m) {
    return {
      ok: false,
      reason: 'graphql me media nahi mila — doc_id purana ho sakta hai',
      status: res.status,
      sample: text.slice(0, 500),
    };
  }

  // carousel ke children, warna khud
  const nodes = m.edge_sidecar_to_children?.edges?.length
    ? m.edge_sidecar_to_children.edges.map((e) => e.node)
    : [m];

  const media = nodes.map(pickBest).filter(Boolean);
  const firstVideo = media.find((x) => x.type === 'video');

  return {
    ok: true,
    data: {
      source: 'graphql',
      shortcode: m.shortcode || shortcode,
      is_video: Boolean(firstVideo),
      video_url: firstVideo?.url || null,
      thumbnail_url: m.display_url ? clean(m.display_url) : null,
      username: m.owner?.username || null,
      caption: (m.edge_media_to_caption?.edges?.[0]?.node?.text || '').slice(0, 300),
      duration: m.video_duration || null,
      media,
    },
  };
}

// ---------------------------------------------------------------- TIER 2
async function fromEmbed(shortcode) {
  const res = await fetch(`https://www.instagram.com/p/${shortcode}/embed/captioned/`, {
    headers: baseHeaders({ Referer: 'https://www.instagram.com/' }),
  });

  if (!res.ok) return { ok: false, reason: `embed HTTP ${res.status}`, status: res.status };
  const html = await res.text();

  const video = firstMatch(html, [
    /"video_url":"(.*?)"/,
    /"video_versions":\[\{[^}]*?"url":"(.*?)"/,
    /property="og:video"\s+content="(.*?)"/,
    /"playable_url(?:_quality_hd)?":"(.*?)"/,
  ]);

  const image = firstMatch(html, [
    /"display_url":"(.*?)"/,
    /class="EmbeddedMediaImage"[^>]*?src="(.*?)"/,
    /property="og:image"\s+content="(.*?)"/,
  ]);

  const username = firstMatch(html, [
    /"owner":\{[^}]*?"username":"(.*?)"/,
    /"username":"(.*?)"/,
  ]);

  const caption = firstMatch(html, [
    /"edge_media_to_caption".*?"text":"(.*?)"/,
    /<div class="Caption".*?<\/a>(.*?)<div class="CaptionComments"/s,
  ]);

  if (!video && !image) {
    // debug ke liye: page me koi bhi CDN link mila ya nahi
    const cdn = [...html.matchAll(/https:\\?\/\\?\/[^"'\s]*?(?:cdninstagram\.com|fbcdn\.net)[^"'\s]*/g)]
      .slice(0, 3)
      .map((x) => clean(x[0]).slice(0, 160));

    return {
      ok: false,
      reason: 'embed me media nahi mila',
      status: res.status,
      htmlLength: html.length,
      cdnLinksFound: cdn,
      hasLoginWall: /loginForm|Log in to Instagram|LoginAndSignupPage/i.test(html),
      sample: html.slice(0, 700),
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

// ---------------------------------------------------------------- TIER 3
async function fromApi(shortcode) {
  const mediaId = shortcodeToMediaId(shortcode);

  const res = await fetch(`https://www.instagram.com/api/v1/media/${mediaId}/info/`, {
    headers: baseHeaders({
      'x-ig-app-id': IG_APP_ID,
      Accept: '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: `https://www.instagram.com/p/${shortcode}/`,
    }),
  });

  const text = await res.text();
  if (!res.ok) return { ok: false, reason: `api HTTP ${res.status}`, status: res.status, sample: text.slice(0, 300) };

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'api ne JSON nahi bheja', status: res.status, sample: text.slice(0, 300) };
  }

  const item = json?.items?.[0];
  if (!item) {
    return {
      ok: false,
      reason: 'api me items nahi mile',
      status: res.status,
      igMessage: json?.message || json?.error_type || null,
      sample: text.slice(0, 300),
    };
  }

  const nodes = item.carousel_media?.length ? item.carousel_media : [item];
  const media = nodes.map(pickBest).filter(Boolean);
  const firstVideo = media.find((x) => x.type === 'video');

  return {
    ok: true,
    data: {
      source: 'api',
      shortcode: item.code || shortcode,
      is_video: Boolean(firstVideo),
      video_url: firstVideo?.url || null,
      thumbnail_url: item.image_versions2?.candidates?.[0]?.url || null,
      username: item.user?.username || null,
      caption: (item.caption?.text || '').slice(0, 300),
      duration: item.video_duration || null,
      media,
    },
  };
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

  const TIERS = [
    ['graphql', fromGraphQL],
    ['embed', fromEmbed],
    ['api', fromApi],
  ];

  for (const [name, fn] of TIERS) {
    try {
      const r = await fn(shortcode);
      const { ok, data, ...diag } = r;
      attempts.push({ tier: name, ok, ...(debug ? diag : { reason: diag.reason }) });
      if (ok) return res.status(200).json(debug ? { ...data, attempts } : data);
    } catch (e) {
      attempts.push({ tier: name, ok: false, reason: `${e.name}: ${e.message}` });
    }
  }

  return res.status(502).json({
    error: 'Reel fetch nahi ho paayi',
    hint: 'Reel private ho sakti hai, doc_id purana ho sakta hai, ya Instagram ne IP block kiya hai.',
    shortcode,
    docIdUsed: DOC_ID,
    attempts,
  });
}
