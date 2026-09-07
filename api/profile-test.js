// ============================================================
//  PROBE v8  —  ab tak ki sabse alag koshish
//
//  v7 ke nateeje ne meri ek theory tod di aur ek nayi baat dikhai.
//
//  TOOTI THEORY: maine kaha tha ki "SecFetch Policy violation" isliye
//  aa raha hai kyunki main mobile endpoint par browser wale sec-fetch
//  headers bhej raha tha. Maine wo headers hata diye. Error phir bhi
//  waisa ka waisa aaya. Yaani wo error hamare headers ki wajah se tha
//  hi nahi. Meri theory galat thi.
//
//  NAYI BAAT: profile page 200 deta hai, block nahi karta. 490 KB ka
//  shell aata hai. Iska matlab Instagram mana nahi kar raha — wo bas
//  data HTML me nahi bhejta. Browser me follower count ek ALAG request
//  se aata hai jo shell ke JS chalne ke baad hoti hai:
//
//      POST https://www.instagram.com/graphql/query
//
//  Aur wo request kaam karti hai kyunki browser shell ke andar se
//  `lsd` token, `csrf`, `spin` values aur `doc_id` nikaal kar bhejta
//  hai. Hum ye aaj tak ek baar bhi nahi kiya. reel.js me bhi doc_id
//  hardcoded aur purana pada hai, shell se nikala hua nahi.
//
//  Isliye v8 ek hi kaam karta hai, par dhang se: shell uthao, uske
//  andar se browser wale saare tokens nikalo, aur wahi POST khud
//  banakar bhejo.
//
//  429 wali baat bhi note karne layak hai: teeno web_profile_info
//  attempts par status 429 aur body ki lambai 0 thi. Khaali body ka
//  matlab hai ki request app tak pahunchi hi nahi, edge par hi ruk
//  gayi. Isliye usi endpoint ko chhedne ka ab koi fayda nahi. graphql
//  ek alag endpoint hai aur uska limiter alag hota hai.
//
//  Chalao:
//   /api/profile-test?u=natgeo
// ============================================================

const IG_APP_ID = '936619743392459';
const T = 7000;
const BUDGET = 22000;

const UA_WEB =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

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

function pageHeaders(cookie, site = 'same-origin', referer) {
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
  if (site === 'same-origin') h.referer = referer || 'https://www.instagram.com/';
  if (cookie) h.cookie = cookie;
  return h;
}

/* ---------------------------------------------------------------
   Shell ke andar se wo sab nikalna jo browser graphql POST me
   bhejta hai. Yahi is probe ka dil hai.
   --------------------------------------------------------------- */
function one(html, re) {
  const m = html.match(re);
  return m ? m[1] : null;
}
function many(html, re, cap = 40) {
  const out = [];
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = r.exec(html)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
    if (out.length >= cap) break;
  }
  return out;
}

function extractTokens(html) {
  return {
    lsd:
      one(html, /"LSD",\s*\[\s*\]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/) ||
      one(html, /name="lsd"\s+value="([^"]+)"/) ||
      one(html, /"lsd"\s*:\s*"([^"]{6,})"/),
    csrf: one(html, /"csrf_token"\s*:\s*"([^"]+)"/),
    spinR: one(html, /"__spin_r"\s*:\s*(\d+)/) || one(html, /"server_revision"\s*:\s*(\d+)/),
    spinT: one(html, /"__spin_t"\s*:\s*(\d+)/),
    rev: one(html, /"rev"\s*:\s*(\d+)/) || one(html, /"consistency"\s*:\s*\{\s*"rev"\s*:\s*(\d+)/),
    hsi: one(html, /"hsi"\s*:\s*"(\d+)"/),
    hs: one(html, /"haste_session"\s*:\s*"([^"]+)"/),
    appId: one(html, /"X-IG-App-ID"\s*:\s*"(\d+)"/) || one(html, /"APP_ID"\s*:\s*"(\d+)"/),
    // Shell me kaunse doc_id aur kaunse query naam maujood hain
    docIds: many(html, /"doc_id"\s*:\s*"?(\d{8,})/),
    profileQueries: many(html, /(Polaris[A-Za-z]*Profile[A-Za-z]*Query)/),
    anyQueries: many(html, /(Polaris[A-Za-z]{4,60}Query)/, 25),
    userIdInShell:
      one(html, /"profile_id"\s*:\s*"(\d+)"/) ||
      one(html, /"owner_id"\s*:\s*"(\d+)"/) ||
      one(html, /"user_id"\s*:\s*"(\d+)"/) ||
      one(html, /"id"\s*:\s*"(\d{6,})"\s*,\s*"username"/),
  };
}

/* jazoest = "2" + lsd ke har character ka char code jodo.
   Facebook ka apna checksum hai, browser bhi yahi bhejta hai. */
function jazoest(lsd) {
  if (!lsd) return null;
  let sum = 0;
  for (let i = 0; i < lsd.length; i++) sum += lsd.charCodeAt(i);
  return '2' + sum;
}

function grabFollowers(t) {
  let m = t.match(/"follower_count"\s*:\s*(\d+)/);
  if (m) return Number(m[1]);
  m = t.match(/"edge_followed_by"\s*:\s*\{\s*"count"\s*:\s*(\d+)/);
  if (m) return Number(m[1]);
  return null;
}
function countLikes(t) {
  const a = t.match(/"like_count"\s*:\s*\d+/g);
  const b = t.match(/"edge_liked_by"\s*:\s*\{\s*"count"/g);
  return Math.max(a ? a.length : 0, b ? b.length : 0);
}

async function guestCookie() {
  const jar = {};
  let homeLen = 0;
  try {
    const r = await fetch('https://www.instagram.com/', {
      headers: pageHeaders(null, 'none'),
      signal: AbortSignal.timeout(T),
    });
    for (const c of r.headers.getSetCookie?.() || []) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
    const html = await r.text();
    homeLen = html.length;
    if (!jar.csrftoken) {
      const m = html.match(/"csrf_token"\s*:\s*"([^"]+)"/);
      if (m) jar.csrftoken = m[1];
    }
  } catch {}
  return { jar, homeLen, str: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const u = String(req.query.u || 'natgeo').trim().replace(/^@/, '');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(u)) {
    return res.status(400).json({ error: 'Pass ?u=natgeo' });
  }
  // Agar browser se asli doc_id mil jaye to yahan se pass kar sakte hain
  const forcedDoc = String(req.query.doc || '').replace(/\D/g, '') || null;

  const startedAt = Date.now();
  const attempts = [];
  let followers = null, posts = 0;

  const push = async (tier, fn) => {
    if (Date.now() - startedAt > BUDGET) { attempts.push({ tier, skipped: 'out of time' }); return; }
    try { attempts.push({ tier, ...(await fn()) }); }
    catch (e) { attempts.push({ tier, error: `${e.name}: ${e.message}` }); }
  };

  const { jar, str: cookie, homeLen } = await guestCookie();

  // === Step 1: shell uthao aur uske andar jhaanko ===
  let tok = null, shellLen = 0;
  await push('1 shell + token extract', async () => {
    const r = await fetch(`https://www.instagram.com/${encodeURIComponent(u)}/`, {
      headers: pageHeaders(cookie, 'same-origin'),
      redirect: 'follow',
      signal: AbortSignal.timeout(T),
    });
    const t = await r.text();
    shellLen = t.length;
    tok = extractTokens(t);
    const f = grabFollowers(t);
    if (f != null) followers = f;
    return {
      status: r.status,
      length: t.length,
      followersInShell: f,
      // Sabse zaroori jawab: shell me tokens mile ya nahi
      found: {
        lsd: Boolean(tok.lsd),
        csrf: Boolean(tok.csrf),
        spinR: Boolean(tok.spinR),
        hsi: Boolean(tok.hsi),
        docIdCount: tok.docIds.length,
        profileQueryCount: tok.profileQueries.length,
        userIdInShell: tok.userIdInShell,
      },
      docIds: tok.docIds.slice(0, 12),
      profileQueries: tok.profileQueries.slice(0, 12),
      anyQueries: tok.anyQueries.slice(0, 20),
    };
  });

  // === Step 2: wahi POST jo browser karta hai ===
  // Ye aaj tak ek baar bhi try nahi hua. reel.js me bhi doc_id
  // hardcoded pada hai, shell se nikala hua nahi.
  const gqlCookie = [cookie, tok?.csrf ? `csrftoken=${tok.csrf}` : '']
    .filter(Boolean).join('; ');

  async function graphql(label, endpoint, docId, variables, friendly) {
    const body = new URLSearchParams();
    body.set('av', '0');
    body.set('__d', 'www');
    body.set('__user', '0');
    body.set('__a', '1');
    body.set('__req', '1');
    body.set('dpr', '1');
    body.set('__ccg', 'EXCELLENT');
    if (tok?.hs) body.set('__hs', tok.hs);
    if (tok?.spinR) { body.set('__rev', tok.spinR); body.set('__spin_r', tok.spinR); }
    if (tok?.hsi) body.set('__hsi', tok.hsi);
    body.set('__spin_b', 'trunk');
    body.set('__spin_t', String(Math.floor(Date.now() / 1000)));
    if (tok?.lsd) { body.set('lsd', tok.lsd); body.set('jazoest', jazoest(tok.lsd)); }
    body.set('fb_api_caller_class', 'RelayModern');
    if (friendly) body.set('fb_api_req_friendly_name', friendly);
    body.set('variables', JSON.stringify(variables));
    body.set('server_timestamps', 'true');
    body.set('doc_id', docId);

    const headers = {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://www.instagram.com',
      referer: `https://www.instagram.com/${u}/`,
      'user-agent': UA_WEB,
      'x-ig-app-id': tok?.appId || IG_APP_ID,
      'x-fb-lsd': tok?.lsd || '',
      'x-csrftoken': tok?.csrf || jar.csrftoken || '',
      'x-asbd-id': '129477',
      'x-ig-www-claim': '0',
      'x-fb-friendly-name': friendly || '',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      priority: 'u=1, i',
      ...CH,
    };
    if (gqlCookie) headers.cookie = gqlCookie;

    const r = await fetch(endpoint, {
      method: 'POST', headers, body: body.toString(),
      signal: AbortSignal.timeout(T),
    });
    const t = await r.text();
    const f = grabFollowers(t);
    const l = countLikes(t);
    if (f != null && followers == null) followers = f;
    if (l > posts) posts = l;
    return {
      status: r.status, length: t.length, followers: f, likeCounts: l,
      sample: t.slice(0, 220),
    };
  }

  // Shell se nikle doc_id sabse pehle. Agar tum browser se asli
  // doc_id de doge to wo &doc= se sabse upar aa jayega.
  const candidates = [];
  if (forcedDoc) candidates.push(forcedDoc);
  for (const d of tok?.docIds || []) if (!candidates.includes(d)) candidates.push(d);

  const vars = { username: u, relay_header: false, render_surface: 'PROFILE' };

  for (let i = 0; i < Math.min(candidates.length, 4) && followers == null; i++) {
    const d = candidates[i];
    await push(`2.${i + 1} graphql/query doc_id ${d}`, () =>
      graphql('gq', 'https://www.instagram.com/graphql/query', d, vars, 'PolarisProfilePageContentQuery'));
  }

  // Doosra endpoint. Instagram dono chalata hai aur inke limiter alag hain.
  if (followers == null && candidates.length) {
    await push(`3 api/graphql doc_id ${candidates[0]}`, () =>
      graphql('gq2', 'https://www.instagram.com/api/graphql', candidates[0], vars, 'PolarisProfilePageContentQuery'));
  }

  // === Step 4: sirf ye dekhne ke liye ki 429 abhi bhi edge par hai ===
  await push('4 web_profile_info (sirf tulna ke liye)', async () => {
    const r = await fetch(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`,
      { headers: {
          'user-agent': UA_WEB, accept: '*/*', 'x-ig-app-id': IG_APP_ID,
          referer: `https://www.instagram.com/${u}/`,
          'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
          ...(gqlCookie ? { cookie: gqlCookie } : {}),
        },
        signal: AbortSignal.timeout(T) }
    );
    const t = await r.text();
    const f = grabFollowers(t);
    if (f != null && followers == null) followers = f;
    return {
      status: r.status, length: t.length, followers: f,
      // khaali body = edge par ruka. bhari body = app tak pahuncha.
      blockedAtEdge: r.status === 429 && t.length === 0,
      sample: t.slice(0, 160),
    };
  });

  return res.status(200).json({
    verdict:
      followers != null && posts >= 3 ? 'BUILDABLE — followers aur post counts dono mile'
      : followers != null ? 'PARTIAL — followers mile, posts nahi'
      : 'still nothing',
    followers,
    postsFound: posts,
    // Agar ye false hai to shell se token nikalna hi fail hai aur
    // mujhe browser se asli graphql request chahiye.
    tokensExtracted: tok
      ? { lsd: Boolean(tok.lsd), csrf: Boolean(tok.csrf), spinR: tok.spinR, hsi: tok.hsi,
          docIdsFound: tok.docIds.length }
      : null,
    homepageLength: homeLen,
    shellLength: shellLen,
    cookiesCollected: Object.keys(jar),
    hasDatr: Object.keys(jar).includes('datr'),
    tookMs: Date.now() - startedAt,
    attempts,
  });
}
