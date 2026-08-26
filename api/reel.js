// ============================================================
//  STAGE 1 — Instagram Reel Downloader API
//  Bas yahi ek file. Koi npm package nahi, koi database nahi.
//
//  Test:  https://aapka-project.vercel.app/api/reel?url=<reel link>
//  Debug: ...&debug=1   (agar kaam na kare to ye output mujhe bhejna)
// ============================================================

// Instagram ka apna base64 alphabet (standard base64 se alag order hai)
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const IG_APP_ID = '936619743392459'; // public web app id — browser har request me bhejta hai

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// ---------------------------------------------------------------- helpers

/** Kisi bhi Instagram link se shortcode nikaalta hai */
function extractShortcode(input) {
  if (!input) return null;
  const s = String(input).trim();

  // user ne sirf shortcode paste kiya ho
  if (/^[A-Za-z0-9_-]{5,30}$/.test(s) && !s.includes('/')) return s;

  const m = s.match(
    /instagram\.com\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i
  );
  return m ? m[1] : null;
}

/** shortcode -> numeric media id (19 digits) */
function shortcodeToMediaId(shortcode) {
  let id = 0n;
  for (const ch of shortcode.slice(0, 11)) {
    const i = ALPHABET.indexOf(ch);
    if (i === -1) throw new Error('Invalid shortcode');
    id = id * 64n + BigInt(i);
  }
  return id.toString();
}

/** Instagram ke escaped JSON strings saaf karta hai */
function clean(s) {
  return s
    .replace(/\\u0026/g, '&')
    .replace(/\\u003C/gi, '<')
    .replace(/\\u003E/gi, '>')
    .replace(/\\\//g, '/')
    .replace(/\\"/g, '"')
    .replace(/\\n/g, ' ');
}

/** Pehla regex jo match kare uska capture group return karta hai */
function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) return clean(m[1]);
  }
  return null;
}

// ---------------------------------------------------------------- TIER 1
// Embed page: public hai, login nahi maangta, bilkul free.
async function fromEmbed(shortcode) {
  const res = await fetch(
    `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
    {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.instagram.com/',
      },
    }
  );

  if (!res.ok) return { ok: false, reason: `embed HTTP ${res.status}` };
  const html = await res.text();

  // Instagram HTML ka structure badalta rehta hai, isliye kai patterns try karte hain
  const video = firstMatch(html, [
    /"video_url":"(.*?)"/,
    /"video_versions":\[\{[^}]*?"url":"(.*?)"/,
    /property="og:video"\s+content="(.*?)"/,
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
    return {
      ok: false,
      reason: 'embed me media nahi mila',
      // debug ke liye HTML ka tukda rakhte hain
      htmlSample: html.slice(0, 1500),
      htmlLength: html.length,
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
      media: video
        ? [{ type: 'video', url: video }]
        : [{ type: 'image', url: image }],
    },
  };
}

// ---------------------------------------------------------------- TIER 2
// Public web API. Zyada reliable data deta hai (carousel, duration) par
// datacenter IP se rate limit jaldi lagta hai.
async function fromApi(shortcode) {
  const mediaId = shortcodeToMediaId(shortcode);

  const res = await fetch(
    `https://www.instagram.com/api/v1/media/${mediaId}/info/`,
    {
      headers: {
        'User-Agent': UA,
        'x-ig-app-id': IG_APP_ID,
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `https://www.instagram.com/p/${shortcode}/`,
      },
    }
  );

  if (!res.ok) return { ok: false, reason: `api HTTP ${res.status}` };

  const json = await res.json().catch(() => null);
  const item = json?.items?.[0];
  if (!item) return { ok: false, reason: 'api me items nahi mile' };

  // ek node se sabse achhi quality nikalta hai
  const pick = (node) => {
    if (node.video_versions?.length) {
      const best = [...node.video_versions].sort(
        (a, b) => (b.width || 0) - (a.width || 0)
      )[0];
      return { type: 'video', url: best.url, width: best.width, height: best.height };
    }
    const cands = node.image_versions2?.candidates || [];
    const best = [...cands].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
    return best ? { type: 'image', url: best.url, width: best.width, height: best.height } : null;
  };

  // carousel (multiple photos/videos) bhi handle hota hai
  const media = (item.carousel_media?.length ? item.carousel_media : [item])
    .map(pick)
    .filter(Boolean);

  const firstVideo = media.find((m) => m.type === 'video');

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
  // CORS — Stage 1 me sabke liye khula hai. Stage 2 me ise apni site tak seemit karenge.
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

  // --- Tier 1
  try {
    const r = await fromEmbed(shortcode);
    attempts.push({ tier: 'embed', ok: r.ok, reason: r.reason, ...(debug && r.htmlSample ? { htmlSample: r.htmlSample, htmlLength: r.htmlLength } : {}) });
    if (r.ok) {
      return res.status(200).json(debug ? { ...r.data, attempts } : r.data);
    }
  } catch (e) {
    attempts.push({ tier: 'embed', ok: false, reason: e.message });
  }

  // --- Tier 2
  try {
    const r = await fromApi(shortcode);
    attempts.push({ tier: 'api', ok: r.ok, reason: r.reason });
    if (r.ok) {
      return res.status(200).json(debug ? { ...r.data, attempts } : r.data);
    }
  } catch (e) {
    attempts.push({ tier: 'api', ok: false, reason: e.message });
  }

  // --- dono fail
  return res.status(502).json({
    error: 'Reel fetch nahi ho paayi',
    hint: 'Reel private ho sakti hai, ya Instagram ne is server ka IP block kar diya hai.',
    shortcode,
    attempts,
  });
}
