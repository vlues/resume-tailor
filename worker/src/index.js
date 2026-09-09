// Resume Tailor API — Cloudflare Worker
// Endpoints:
//   GET  /api/health          → { ok, hasKey, needsCode }
//   POST /api/fetch-job       → { jobText, title, company, source } (reads a job posting URL)
//   POST /api/tailor          → tailored resume JSON (calls Claude)
//
// Secrets (wrangler secret put): ANTHROPIC_API_KEY (required), ACCESS_CODE (optional)

import BANNED from '../banned.json';
import COMPANIES from '../companies.json';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/api/health') {
        const base = { ok: true, hasKey: !!env.ANTHROPIC_API_KEY, needsCode: !!env.ACCESS_CODE };
        if (url.searchParams.get('deep') === '1' && env.ANTHROPIC_API_KEY) {
          return json({ ...base, ai: await deepHealth(env) }, 200, cors);
        }
        return json(base, 200, cors);
      }

      if (url.pathname === '/api/jobs') {
        const resp = await jobsFeed(url, env, cors);
        // edge/browser revalidation: cheap 304 when nothing changed
        try {
          const et = resp.headers.get('ETag');
          if (et && request.headers.get('If-None-Match') === et) {
            return new Response(null, { status: 304, headers: { 'ETag': et, ...cors } });
          }
        } catch {}
        return resp;
      }
      if (url.pathname === '/api/apps') {
        return await appsStore(request, url, env, cors);
      }
      if (url.pathname === '/api/errors') {
        if (!env.ACCESS_CODE || (url.searchParams.get('code') || '').trim() !== env.ACCESS_CODE) {
          return json({ error: 'bad_code' }, 401, cors);
        }
        let ring = [];
        try { ring = JSON.parse(await env.JOBS_KV.get('errors:ring') || '[]'); } catch {}
        return json({ ok: true, errors: ring }, 200, cors);
      }

      if (request.method !== 'POST') {
        return json({ error: 'Not found' }, 404, cors);
      }
      if (Number(request.headers.get('content-length') || 0) > 300000) {
        return json({ error: 'too_big', message: 'That’s too much text — trim the resume or job description and try again.' }, 413, cors);
      }

      const body = await request.json().catch(() => ({}));

      if (url.pathname === '/api/fetch-job') {
        return await fetchJob(body, cors);
      }
      if (url.pathname === '/api/slop') {
        if (env.ACCESS_CODE && String(body.accessCode || '').trim() !== env.ACCESS_CODE) {
          return json({ error: 'bad_code', message: 'That access code isn’t right — check it in the 🔑 box.' }, 401, cors);
        }
        return await slopCheck(body, env, cors);
      }
      if (url.pathname === '/api/tailor') {
        // Access code gates only the expensive Claude call
        if (env.ACCESS_CODE && String(body.accessCode || '').trim() !== env.ACCESS_CODE) {
          return json({ error: 'bad_code', message: 'That access code isn’t right — check it in the 🔑 box.' }, 401, cors);
        }
        return await tailor(body, env, cors);
      }
      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      await logError(env, url.pathname, String(err && err.message || err));
      return json({ error: 'server_error', message: String(err && err.message || err) }, 500, cors);
    }
  },

  // Cron Trigger (every 3h, see wrangler.toml): refresh the KV feed + digest.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshFeedCron(env));
  },
};

// last-100 failures, oldest out — so "what broke?" has an answer
async function logError(env, endpoint, cause) {
  try {
    if (!env.JOBS_KV) return;
    let ring = [];
    try { ring = JSON.parse(await env.JOBS_KV.get('errors:ring') || '[]'); } catch {}
    ring.push({ at: new Date().toISOString(), endpoint, cause: String(cause).slice(0, 300) });
    await env.JOBS_KV.put('errors:ring', JSON.stringify(ring.slice(-100)));
  } catch {}
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const ok = allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...JSON_HEADERS, ...cors } });
}

// Tiny live call so failures show their real cause (cached 60s to stay cheap).
async function deepHealth(env) {
  const cache = caches.default;
  const KEY = 'https://resume-tailor.internal/deep-health';
  const hit = await cache.match(KEY).catch(() => null);
  if (hit) return await hit.json();
  const probe = async (model) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { status: r.status, body: (await r.text()).slice(0, 400) };
  };
  const primary = env.CLAUDE_MODEL || 'claude-sonnet-5';
  const result = { primary: { model: primary, ...(await probe(primary)) } };
  if (result.primary.status !== 200) {
    result.fallback = { model: 'claude-sonnet-4-5', ...(await probe('claude-sonnet-4-5')) };
  }
  await cache.put(KEY, new Response(JSON.stringify(result), {
    headers: { 'content-type': 'application/json', 'Cache-Control': 'public, max-age=60' },
  })).catch(() => {});
  return result;
}

// Map Anthropic's error JSON to a message a non-technical user can act on.
function friendlyClaudeError(status, errText) {
  let type = '', msg = '';
  try { const e = JSON.parse(errText); type = (e.error && e.error.type) || ''; msg = (e.error && e.error.message) || ''; } catch {}
  if (/credit balance/i.test(msg)) return 'The AI credits ran out — Parker needs to top up the Anthropic account.';
  if (type === 'authentication_error') return 'The AI key stopped working — Parker needs to re-run setup-api.sh.';
  if (type === 'permission_error') return 'The AI key isn’t allowed to do this — Parker should check the Anthropic console.';
  if (type === 'overloaded_error' || status === 529) return 'The AI is overloaded right now — wait 30 seconds and tap Tailor again.';
  if (status === 429) return 'The AI is a little busy — wait a few seconds and tap Tailor again.';
  if (type === 'not_found_error') return 'The AI model isn’t available on this key — tell Parker.';
  return 'The AI hit a snag (' + (type || status) + '). Try again in a moment.';
}

// ------------------------------------------------------------------ jobs feed

const DEFAULT_SYNONYMS = 'customer,support,success,service,helpdesk,help desk,client,community,care,happiness,onboarding';
const LOCATION_OK = /worldwide|anywhere|global|international|europe|emea|remote|kosovo|spain|utc|cet|balkan|see posting|not specified/i;
const STRONG_OK = /worldwide|anywhere|global|europe|emea/i;
// Rejects: US/other-region locks, in-office, and US-timezone shift locks.
const LOCATION_BAD = /U\.?S\.?[- .]?based|USA only|US only|United States only|Canada only|North America|Americas only|LATAM|APAC only|(?:\bEast\b|\bCentral\b|\bWest\b)(?!(?:ern)? ?Europe)|\bFederal\b|on[- ]?site|in[- ]?office|\bhybrid\b|\b[PECM][SD]?T\b ?(?:hours|time|business)/i;
const UA = { 'User-Agent': 'ResumeTailor/1.0' };
const CF_CACHE = { cf: { cacheTtl: 900, cacheEverything: true } };
// every upstream call gets a hard timeout so one slow source can't hang the feed
function tfetch(url, opts = {}, ms = 8000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}
const EOR_FRIENDLY = new Set(COMPANIES.eor_friendly.map(c => normCo(c)));

function normCo(c) { return String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/com$/, ''); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Job locked to a specific country/region she can't work from (unless the
// location also says Europe/anywhere).
const WRONG_REGION = /colombia|india|philippines|brazil|mexico|nigeria|pakistan|indonesia|vietnam|china|japan|korea|australia|new zealand|singapore|malaysia|thailand|kenya|south africa|egypt|argentina|peru|chile|\bcanada\b|united states|\busa?\b|latam|apac/i;

// Fetch every source live: aggregators + curated boards.
// ~41 subrequests — stays under the free tier's 50/invocation.
async function fetchAllRaw() {
  const names = [
    'Remotive', 'RemoteOK', 'WeWorkRemotely', 'Jobicy (Europe)', 'Jobicy (anywhere)',
    ...COMPANIES.greenhouse.map(b => 'Board: ' + b), ...COMPANIES.ashby.map(b => 'Board: ' + b),
    ...COMPANIES.lever.map(b => 'Board: ' + b), ...COMPANIES.workable.map(b => 'Board: ' + b),
  ];
  const results = await Promise.allSettled([
    fetchRemotive(), fetchRemoteOK(), fetchWWR(), fetchJobicy('europe'), fetchJobicy('anywhere'),
    ...COMPANIES.greenhouse.map(fetchGreenhouseBoard), ...COMPANIES.ashby.map(fetchAshbyBoard),
    ...COMPANIES.lever.map(fetchLeverBoard), ...COMPANIES.workable.map(fetchWorkableBoard),
  ]);
  const down = names.filter((_, i) => results[i].status === 'rejected');
  const raw = results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
    .filter(j => j && j.title && j.url)
    .map(j => ({ ...j, ts: new Date(j.date).getTime() || 0 }));
  return { raw, down };
}

// All hard filters in one place: title synonyms, location, freshness, dedupe.
function filterFeed(raw, synCsv, freshDays) {
  const syn = String(synCsv || DEFAULT_SYNONYMS).split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
  // word-start boundary so "service" can't match "Microservices"
  const titleRe = new RegExp('\\b(?:' + syn.map(escapeRe).join('|') + ')', 'i');
  const now = Date.now();
  const seen = new Set();
  const out = [];
  for (const j0 of raw) {
    const j = { ...j0 };
    if (!titleRe.test(j.title)) continue;
    const loc = j.location || '';
    // a US-region/shift lock in the TITLE disqualifies even a "work from anywhere" row
    if (LOCATION_BAD.test(j.title)) continue;
    if (!STRONG_OK.test(loc)) {
      if (LOCATION_BAD.test(loc)) continue;
      if (WRONG_REGION.test(loc)) continue;
      if (loc && !LOCATION_OK.test(loc)) continue;
    }
    if (!j.ts || now - j.ts > freshDays * 86400000) continue;   // unknown age = can't promise fresh
    const key = normCo(j.company) + '|' + j.title.toLowerCase().replace(/\s+/g, ' ').trim();
    if (seen.has(key)) continue;
    seen.add(key);
    j.kosovoOk = /anywhere|worldwide|global|contractor|\beor\b/i.test(j.title + ' ' + loc) || EOR_FRIENDLY.has(normCo(j.company));
    // landability score: entry/mid support up, leadership down, anywhere+salary up, fresh up
    let s = 0;
    s -= ((now - j.ts) / 86400000) * 2;
    if (/anywhere|worldwide|global/i.test(loc)) s += 8;
    else if (/emea|europe/i.test(loc)) s += 6;
    if (j.kosovoOk) s += 4;
    if (j.salary) s += 3;
    if (/director|head of|vp|vice president|principal|\blead\b|manager,? (of|customer success managers)/i.test(j.title)) s -= 14;
    else if (/senior|\bsr\.?\b|staff\b|engineer/i.test(j.title)) s -= 6;
    if (/representative|specialist|associate|agent|advocate|advisor|coordinator/i.test(j.title)) s += 5;
    j.score = Math.round(s * 10) / 10;
    out.push(j);
  }
  out.sort((a, b) => b.score - a.score || b.ts - a.ts);
  return out.slice(0, 80);
}

async function buildFeed(synCsv, freshDays) {
  const { raw, down } = await fetchAllRaw();
  return { jobs: filterFeed(raw, synCsv, freshDays), down, raw };
}

// GET /api/jobs?syn=…&fresh=7 — KV-cached for the default view (cron keeps it
// warm); custom synonym lists build live. Stale KV is the last-ditch fallback.
async function jobsFeed(url, env, cors) {
  const syn = (url.searchParams.get('syn') || '').slice(0, 400);
  const fresh = Math.min(30, Math.max(1, Number(url.searchParams.get('fresh')) || 7));
  const isDefault = !syn && fresh === 7;

  // Fresh raw jobs in KV (the cron keeps them warm) → filter and serve
  // instantly, whatever her synonym list says. No upstream fetches.
  let kvRaw = null;
  if (env.JOBS_KV) {
    try { kvRaw = JSON.parse(await env.JOBS_KV.get('feed:raw') || 'null'); } catch {}
  }
  if (kvRaw && kvRaw.raw && Date.now() - kvRaw.updated < 4 * 3600000) {
    const jobs = filterFeed(kvRaw.raw, syn, fresh);
    if (jobs.length) {
      const r = json({ ok: true, jobs, updated: kvRaw.updated, down: kvRaw.down || [], cached: true }, 200, cors);
      r.headers.set('ETag', 'W/"' + kvRaw.updated + '-' + jobs.length + '-' + syn.length + '"');
      r.headers.set('Cache-Control', 'public, max-age=300');
      r.headers.set('Access-Control-Expose-Headers', 'ETag');
      return r;
    }
  }
  try {
    const feed = await buildFeed(syn, fresh);
    if (!feed.jobs.length) throw new Error('empty feed');
    if (env.JOBS_KV) {
      await env.JOBS_KV.put('feed:raw', JSON.stringify({ raw: trimRaw(feed.raw), updated: Date.now(), down: feed.down })).catch(() => {});
    }
    return json({ ok: true, jobs: feed.jobs, updated: Date.now(), down: feed.down }, 200, cors);
  } catch (e) {
    if (kvRaw && kvRaw.raw) {   // stale is better than blank — say how old it is
      const jobs = filterFeed(kvRaw.raw, syn, 30);
      if (jobs.length) return json({ ok: true, jobs, updated: kvRaw.updated, down: ['live refresh failed — showing the saved feed'], stale: true }, 200, cors);
    }
    await logError(env, '/api/jobs', 'all sources failed: ' + String(e && e.message || e));
    return json({ error: 'feed_down', message: 'Couldn’t load jobs from any source right now. Paste a job link below instead — that still works.' }, 503, cors);
  }
}

// Keep the KV raw store lean: only jobs from the last 8 days, needed fields only.
function trimRaw(raw) {
  const cutoff = Date.now() - 8 * 86400000;
  return raw.filter(j => j.ts > cutoff)
    .map(j => ({ title: j.title, company: j.company, url: j.url, location: j.location, date: j.date, ts: j.ts, salary: j.salary || '', source: j.source }));
}

// Cron (every 3h): rebuild the default feed into KV, then send the Telegram
// digest if it's due. Failures leave the previous KV feed in place.
async function refreshFeedCron(env) {
  const feed = await buildFeed('', 7);
  if (!feed.jobs.length) return;
  if (env.JOBS_KV) await env.JOBS_KV.put('feed:raw', JSON.stringify({ raw: trimRaw(feed.raw), updated: Date.now(), down: feed.down })).catch(() => {});
  await maybeTelegramDigest(env, feed.jobs).catch(() => {});
}

// One digest a day (top 5 new + Kosovo-relevant), or immediately when a very
// strong job appears. Needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID secrets.
async function maybeTelegramDigest(env, jobs) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.JOBS_KV) return;
  let sent = [];
  try { sent = JSON.parse(await env.JOBS_KV.get('tg:sent') || '[]'); } catch {}
  const sentSet = new Set(sent);
  const now = Date.now();
  const fresh = jobs.filter(j => !sentSet.has(j.url) && now - j.ts < 48 * 3600000);
  if (!fresh.length) return;
  const hot = fresh.filter(j => j.score >= 12 && j.kosovoOk);
  const lastDigest = Number(await env.JOBS_KV.get('tg:lastDigest') || 0);
  if (now - lastDigest < 20 * 3600000 && !hot.length) return;   // one message a day unless something is very good
  const pick = (hot.length && now - lastDigest < 20 * 3600000 ? hot : fresh).slice(0, 5);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = pick.map(j => {
    const hrs = Math.max(1, Math.round((now - j.ts) / 3600000));
    return `• <b>${esc(j.title)}</b> — ${esc(j.company)}\n  ${esc(j.location)} · posted ${hrs}h ago · fit ${j.score}${j.kosovoOk ? ' · 🌍 Kosovo-OK' : ''}${j.salary ? ' · ' + esc(j.salary) : ''}\n  <a href="https://vlues.github.io/resume-tailor/?job=${encodeURIComponent(j.url)}">Tap to tailor</a>`;
  });
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID, parse_mode: 'HTML', disable_web_page_preview: true,
      text: (hot.length ? '🔥 Strong new match' + (pick.length > 1 ? 'es' : '') : '☀️ Today’s best new jobs') + ':\n\n' + lines.join('\n\n'),
    }),
  });
  if (r.ok) {
    for (const j of pick) sentSet.add(j.url);
    await env.JOBS_KV.put('tg:sent', JSON.stringify([...sentSet].slice(-500)));
    await env.JOBS_KV.put('tg:lastDigest', String(now));
  }
}

// Fetchers return RAW jobs — the central filter in buildFeed() does all
// title/location/freshness work so the rules live in exactly one place.

// Remotive: public API with candidate_required_location
async function fetchRemotive() {
  const jobs = [];
  const r = await tfetch('https://remotive.com/api/remote-jobs?search=customer%20support&limit=100', CF_CACHE);
  if (!r.ok) return jobs;
  const d = await r.json();
  for (const j of d.jobs || []) {
    jobs.push({
      title: j.title, company: j.company_name, url: j.url,
      location: j.candidate_required_location || 'Not specified', date: j.publication_date,
      salary: j.salary || '', source: 'Remotive',
    });
  }
  return jobs;
}

// RemoteOK: public API; first element is a legal notice
async function fetchRemoteOK() {
  const jobs = [];
  const r = await tfetch('https://remoteok.com/api?tags=customer%20support', { headers: UA, ...CF_CACHE });
  if (!r.ok) return jobs;
  const d = await r.json();
  for (const j of (Array.isArray(d) ? d : [])) {
    if (!j || !j.position || !j.url) continue;
    const salary = j.salary_min ? `$${Math.round(j.salary_min/1000)}k–$${Math.round((j.salary_max||j.salary_min)/1000)}k` : '';
    jobs.push({
      title: j.position, company: j.company, url: j.url,
      location: j.location || 'Not specified', date: j.date, salary, source: 'RemoteOK',
    });
  }
  return jobs;
}

// We Work Remotely: customer-support RSS
async function fetchWWR() {
  const jobs = [];
  const r = await tfetch('https://weworkremotely.com/categories/remote-customer-support-jobs.rss', { headers: UA, ...CF_CACHE });
  if (!r.ok) return jobs;
  const xml = await r.text();
  for (const it of xml.split('<item>').slice(1)) {
    const pick = tag => {
      const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(it);
      return m ? stripTags(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')).trim() : '';
    };
    const rawTitle = pick('title');            // "Company: Job Title"
    const link = pick('link');
    const region = pick('region') || 'See posting';
    const date = pick('pubDate');
    if (!rawTitle || !link) continue;
    const [company, ...rest] = rawTitle.split(': ');
    let title = rest.join(': ') || rawTitle;
    const sal = /\$\s?\d[\d,.]*k?(?:\s?[-–]\s?\$?\d[\d,.]*k?)?(?:\s?\/\s?(?:year|yr|month|mo|hour|hr))?/i.exec(title);
    title = title.split(/ — | – | \(|\||,? \$/)[0].replace(/[-–—\s]+$/, '').trim() || title;
    jobs.push({ title, company: company || '', url: link, location: region, date, salary: sal ? sal[0].replace(/\s+/g, '') : '', source: 'WeWorkRemotely' });
  }
  return jobs;
}

// Company boards — free public APIs, one subrequest each. The board rosters
// live in worker/companies.json (verified 2026-09-09).
function boardName(board) {
  return COMPANIES.company_names[board] || board.charAt(0).toUpperCase() + board.slice(1);
}

async function fetchGreenhouseBoard(board) {
  const jobs = [];
  const r = await tfetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs`, { headers: UA, ...CF_CACHE });
  if (!r.ok) return jobs;
  const d = await r.json();
  for (const j of d.jobs || []) {
    // only remote-ish rows — board APIs list every office role
    const loc = (j.location && j.location.name) || '';
    if (!/emea|europe|world|anywhere|global|remote/i.test(loc + ' ' + j.title)) continue;
    jobs.push({
      title: j.title, company: boardName(board),
      url: j.absolute_url, location: loc || 'Remote', date: j.updated_at || j.first_published,
      salary: '', source: 'Company board (Greenhouse)',
    });
  }
  return jobs;
}

async function fetchAshbyBoard(board) {
  const jobs = [];
  const r = await tfetch(`https://api.ashbyhq.com/posting-api/job-board/${board}`, { headers: UA, ...CF_CACHE });
  if (!r.ok) return jobs;
  const d = await r.json();
  for (const j of d.jobs || []) {
    const loc = [j.location, ...((j.secondaryLocations || []).map(x => x.location))].filter(Boolean).join('; ');
    if (!/emea|europe|world|anywhere|global|remote/i.test(loc + ' ' + j.title + (j.isRemote ? ' remote' : ''))) continue;
    jobs.push({
      title: j.title, company: boardName(board),
      url: j.jobUrl || j.applyUrl, location: loc || 'Remote', date: j.publishedAt,
      salary: '', source: 'Company board (Ashby)',
    });
  }
  return jobs;
}

async function fetchLeverBoard(board) {
  const jobs = [];
  const r = await tfetch(`https://api.lever.co/v0/postings/${board}?limit=100`, { headers: UA, ...CF_CACHE });
  if (!r.ok) return jobs;
  const d = await r.json();
  for (const j of (Array.isArray(d) ? d : [])) {
    const cat = j.categories || {};
    const loc = [cat.location, ...(cat.allLocations || [])].filter(Boolean).join('; ');
    if (j.workplaceType !== 'remote' && !/emea|europe|world|anywhere|global|remote/i.test(loc)) continue;
    jobs.push({
      title: j.text, company: boardName(board),
      url: j.hostedUrl, location: loc || 'Remote', date: new Date(j.createdAt || 0).toISOString(),
      salary: '', source: 'Company board (Lever)',
    });
  }
  return jobs;
}

async function fetchWorkableBoard(board) {
  const jobs = [];
  const r = await tfetch(`https://apply.workable.com/api/v1/widget/accounts/${board}?details=false`, { headers: UA, ...CF_CACHE });
  if (!r.ok) return jobs;
  const d = await r.json();
  for (const j of d.jobs || []) {
    const loc = [j.city, j.state, j.country].filter(Boolean).join(', ');
    if (!j.telecommuting && !/emea|europe|world|anywhere|global|remote/i.test(loc + ' ' + j.title)) continue;
    jobs.push({
      title: j.title, company: d.name || boardName(board),
      url: j.url, location: (j.telecommuting ? 'Remote — ' : '') + (loc || 'Remote'), date: j.published_on || j.created_at,
      salary: '', source: 'Company board (Workable)',
    });
  }
  return jobs;
}

// Jobicy: public API with region + industry filters (credit: jobicy.com)
async function fetchJobicy(geo) {
  const jobs = [];
  const r = await tfetch(`https://jobicy.com/api/v2/remote-jobs?count=50&geo=${geo}&industry=supporting`, { headers: UA, ...CF_CACHE });
  if (!r.ok) return jobs;
  const d = await r.json();
  for (const j of d.jobs || []) {
    if (!j.jobTitle || !j.url) continue;
    const loc = Array.isArray(j.jobGeo) ? j.jobGeo.join(', ') : (j.jobGeo || '');
    let salary = '';
    if (j.annualSalaryMin) {
      const cur = j.salaryCurrency === 'EUR' ? '€' : j.salaryCurrency === 'GBP' ? '£' : '$';
      salary = `${cur}${Math.round(j.annualSalaryMin/1000)}k–${cur}${Math.round((j.annualSalaryMax||j.annualSalaryMin)/1000)}k`;
    }
    jobs.push({
      title: j.jobTitle, company: j.companyName || '', url: j.url,
      location: loc || 'Not specified', date: j.pubDate, salary, source: 'Jobicy',
    });
  }
  return jobs;
}

// ---------------------------------------------------------------- fetch-job

async function fetchJob(body, cors) {
  const jobUrl = String(body.url || '').trim();
  let parsed;
  try {
    parsed = new URL(jobUrl);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('bad protocol');
  } catch {
    return json({ error: 'bad_url', message: 'That doesn’t look like a link. Paste the full job URL.' }, 400, cors);
  }

  // Dedicated adapters for the big ATS platforms — their pages often block
  // robots or render with JS, but they all expose public JSON/guest endpoints.
  const adapted = await tryAdapters(parsed);
  if (adapted) return json(adapted, 200, cors);

  let html = '';
  try {
    const resp = await tfetch(jobUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    html = await resp.text();
  } catch {
    return json({ error: 'fetch_failed', message: 'Couldn’t open that link. Copy the job description text and paste it instead.' }, 422, cors);
  }

  // Best case: schema.org JobPosting JSON-LD (used by LinkedIn, Indeed, Greenhouse, Lever, Workday, ZipRecruiter…)
  const ld = extractJobPosting(html);
  if (ld && ld.description && stripTags(ld.description).length > 200) {
    return json({
      jobText: stripTags(ld.description),
      title: ld.title || '',
      company: (ld.hiringOrganization && ld.hiringOrganization.name) || '',
      source: 'structured',
    }, 200, cors);
  }

  // Fallback: strip the page to visible text, preferring the main content region.
  let scope = html;
  const main = /<main[\s\S]*?<\/main>/i.exec(html) ||
    /<(?:article|section|div)[^>]*(?:id|class)\s*=\s*["'][^"']*(?:job[_-]?(?:description|details|listing|content|body)|listing[_-]?container|posting)[^"']*["'][\s\S]*?<\/(?:article|section|div)>/i.exec(html);
  if (main && stripTags(main[0]).length > 300) scope = main[0];
  const text = stripTags(scope);
  if (text.length < 300) {
    const isLinkedIn = /linkedin\.com$/.test(parsed.hostname.replace(/^www\./, ''));
    return json({
      error: 'thin_page',
      message: isLinkedIn
        ? 'LinkedIn wouldn’t share this one. Easy fix: open the job, tap “See more”, select and copy the whole description, then paste it below — works every time.'
        : 'That site hides the job details from robots. Copy the job description text and paste it instead — works every time.',
    }, 422, cors);
  }
  // Cap so a giant page doesn't blow the prompt.
  return json({ jobText: text.slice(0, 20000), title: titleFrom(html), company: '', source: 'page' }, 200, cors);
}

async function tryAdapters(u) {
  const host = u.hostname.replace(/^www\./, '');
  try {
    // LinkedIn: /jobs/view/<id> or any /jobs/... page with ?currentJobId=<id>
    if (host.endsWith('linkedin.com')) {
      const id = (u.pathname.match(/\/jobs\/view\/(?:[^/]*-)?(\d{6,})/) || [])[1]
        || u.searchParams.get('currentJobId');
      if (id) {
        const r = await tfetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, {
          headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
        });
        if (r.ok) {
          const html = await r.text();
          const desc = /class="[^"]*show-more-less-html__markup[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html);
          const title = /class="top-card-layout__title[^"]*"[^>]*>([\s\S]*?)<\//.exec(html) || /<title[^>]*>([\s\S]*?)<\/title>/.exec(html);
          const company = /class="topcard__org-name-link[^"]*"[^>]*>([\s\S]*?)<\//.exec(html);
          const text = desc ? stripTags(desc[1]) : '';
          if (text.length > 200) {
            return { jobText: text.slice(0, 20000), title: title ? stripTags(title[1]) : '', company: company ? stripTags(company[1]) : '', source: 'linkedin' };
          }
        }
      }
    }
    // Greenhouse: boards.greenhouse.io/<board>/jobs/<id> (also job-boards.greenhouse.io)
    if (host.endsWith('greenhouse.io')) {
      const m = u.pathname.match(/\/([^/]+)\/jobs\/(\d+)/);
      if (m) {
        const r = await tfetch(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`);
        if (r.ok) {
          const d = await r.json();
          const text = stripTags(unescapeHtml(d.content || ''));
          if (text.length > 200) return { jobText: text.slice(0, 20000), title: d.title || '', company: (d.company_name || m[1]), source: 'greenhouse' };
        }
      }
    }
    // Lever: jobs.lever.co/<company>/<posting-id>
    if (host === 'jobs.lever.co') {
      const m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{16,})/i);
      if (m) {
        const r = await tfetch(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`);
        if (r.ok) {
          const d = await r.json();
          const lists = (d.lists || []).map(l => `${l.text}\n${stripTags(l.content || '')}`).join('\n\n');
          const text = [d.descriptionPlain || stripTags(d.description || ''), lists, d.additionalPlain || ''].filter(Boolean).join('\n\n').trim();
          if (text.length > 200) return { jobText: text.slice(0, 20000), title: d.text || '', company: m[1], source: 'lever' };
        }
      }
    }
    // SmartRecruiters: jobs.smartrecruiters.com/<Company>/<id>-slug
    if (host === 'jobs.smartrecruiters.com') {
      const m = u.pathname.match(/^\/([^/]+)\/(\d{9,})/);
      if (m) {
        const r = await tfetch(`https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`);
        if (r.ok) {
          const d = await r.json();
          const sec = d.jobAd && d.jobAd.sections || {};
          const text = ['jobDescription', 'qualifications', 'additionalInformation', 'companyDescription']
            .map(k => sec[k] ? `${sec[k].title || ''}\n${stripTags(sec[k].text || '')}` : '').filter(Boolean).join('\n\n').trim();
          if (text.length > 200) return { jobText: text.slice(0, 20000), title: d.name || '', company: (d.company && d.company.name) || m[1], source: 'smartrecruiters' };
        }
      }
    }
  } catch { /* fall through to generic fetch */ }
  return null;
}

function unescapeHtml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}

function extractJobPosting(html) {
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      let data = JSON.parse(m[1].trim());
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const type = item && item['@type'];
        if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) return item;
      }
    } catch { /* keep looking */ }
  }
  return null;
}

function stripTags(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function titleFrom(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? stripTags(m[1]).slice(0, 120) : '';
}

// ---------------------------------------------------- application records (KV)

// GET  /api/apps?code=X            → her records (JSON)
// GET  /api/apps?code=X&view=html  → Parker's read-only verification page
// POST /api/apps {accessCode, apps:[…]} → merge by id, newest updatedAt wins.
// Records are slim (no full AI results) and keyed by the access code, so they
// survive a cleared browser and Parker can confirm applications really happened.
async function appsStore(request, url, env, cors) {
  if (!env.ACCESS_CODE) return json({ error: 'no_code_set', message: 'Application sync needs an access code — Parker has to set one with setup-api.sh.' }, 503, cors);
  if (!env.JOBS_KV) return json({ error: 'no_kv', message: 'Storage isn’t set up on the server — tell Parker.' }, 503, cors);

  const key = 'apps:v1';
  const load = async () => { try { return JSON.parse(await env.JOBS_KV.get(key) || '[]'); } catch { return []; } };

  if (request.method === 'GET') {
    if ((url.searchParams.get('code') || '').trim() !== env.ACCESS_CODE) {
      return json({ error: 'bad_code', message: 'Wrong access code.' }, 401, cors);
    }
    const apps = await load();
    if (url.searchParams.get('view') === 'html') return appsHtml(apps, cors);
    if (url.searchParams.get('format') === 'csv') return appsCsv(apps, cors);
    return json({ ok: true, apps }, 200, cors);
  }

  const body = await request.json().catch(() => ({}));
  if (String(body.accessCode || '').trim() !== env.ACCESS_CODE) {
    return json({ error: 'bad_code', message: 'That access code isn’t right — check it in the 🔑 box.' }, 401, cors);
  }
  const incoming = Array.isArray(body.apps) ? body.apps.slice(0, 200) : [];
  const existing = await load();
  const byId = new Map(existing.map(a => [a.id, a]));
  for (const a of incoming) {
    if (!a || !a.id) continue;
    const slim = {
      id: a.id, label: String(a.label || '').slice(0, 160),
      company: String(a.company || '').slice(0, 80), title: String(a.title || '').slice(0, 120),
      url: String(a.url || '').slice(0, 500), source: a.source === 'feed' ? 'feed' : 'pasted',
      contact: String(a.contact || '').slice(0, 160),
      appliedAt: a.appliedAt || null, outreachAt: a.outreachAt || null,
      fu1At: a.fu1At || null, fu2At: a.fu2At || null, proofAt: a.proofAt || null,
      status: String(a.status || 'applied').slice(0, 20), startedAt: a.startedAt || null,
      repliedAt: a.repliedAt || null, interviewAt: a.interviewAt || null, noteLen: Number(a.noteLen) || null,
      score: Number(a.score) || null, dnv: String(a.dnv || '').slice(0, 12),
      resume: String(a.resume || '').slice(0, 6000), cover_note: String(a.cover_note || '').slice(0, 2000),
      updatedAt: a.updatedAt || Date.now(),
    };
    const cur = byId.get(a.id);
    if (!cur || (slim.updatedAt >= (cur.updatedAt || 0))) byId.set(a.id, slim);
  }
  const merged = [...byId.values()].sort((x, y) => (y.appliedAt || y.id) - (x.appliedAt || x.id)).slice(0, 300);
  await env.JOBS_KV.put(key, JSON.stringify(merged));
  // read-back confirm: the UI only says "saved" when this count comes home
  return json({ ok: true, saved: true, count: merged.length }, 200, cors);
}

function appsCsv(apps, cors) {
  const cols = ['appliedAt', 'company', 'title', 'status', 'score', 'dnv', 'source', 'outreachAt', 'fu1At', 'fu2At', 'proofAt', 'url'];
  const fmt = v => v == null ? '' : /At$/.test('' + v) ? v : String(v);
  const d = ts => ts ? new Date(ts).toISOString().slice(0, 10) : '';
  const rows = apps.map(a => [d(a.appliedAt), a.company, a.title, a.status, a.score ?? '', a.dnv, a.source, d(a.outreachAt), d(a.fu1At), d(a.fu2At), d(a.proofAt), a.url]
    .map(c => '"' + String(c ?? '').replace(/"/g, '""') + '"').join(','));
  return new Response(cols.join(',') + '\n' + rows.join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="applications.csv"', ...cors },
  });
}

// Read-only page for Parker: is she applying, and with what?
function appsHtml(apps, cors) {
  const e = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const d = ts => ts ? new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
  const applied = apps.filter(a => a.appliedAt);
  const wk = applied.filter(a => Date.now() - a.appliedAt < 7 * 86400000).length;
  const rows = apps.map(a => `<tr>
    <td>${d(a.appliedAt)}</td><td><b>${e(a.title)}</b><br>${e(a.company)}</td>
    <td>${e(a.status)}${a.proofAt ? ' 📸' : ''}</td><td>${a.score ?? '—'}%</td><td>${e(a.dnv || '—')}</td>
    <td>${d(a.outreachAt)} / ${d(a.fu1At)} / ${d(a.fu2At)}</td>
    <td>${a.url ? `<a href="${e(a.url)}">job</a>` : ''}</td>
    <td><details><summary>resume + note</summary><pre>${e(a.resume)}</pre><hr><p>${e(a.cover_note)}</p></details></td>
  </tr>`).join('');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Applications — verification</title>
  <style>body{font:15px/1.5 -apple-system,sans-serif;margin:16px;color:#222}table{border-collapse:collapse;width:100%}
  td,th{border-bottom:1px solid #ddd;padding:8px 6px;text-align:left;vertical-align:top;font-size:.9em}
  pre{white-space:pre-wrap;font-size:.85em;background:#f6f6f6;padding:8px;border-radius:8px;max-height:300px;overflow:auto}</style>
  <h2>📋 Her applications (${applied.length} applied · ${wk} this week)</h2>
  <p>📸 = she sent proof. Dates column = outreach / follow-up 1 / follow-up 2.</p>
  <table><tr><th>Applied</th><th>Job</th><th>Status</th><th>Match</th><th>Visa</th><th>Sent</th><th>Link</th><th>What she sent</th></tr>${rows}</table>`;
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', ...cors } });
}

// ---------------------------------------------------------------- anti-slop

// Mechanical scan — deterministic, costs nothing. Returns flag objects the
// UI can highlight and a regenerate pass can feed back as complaints.
function slopScan(fields, jobText, sourceText) {
  const flags = [];
  const postingLower = (jobText || '').toLowerCase();
  // numbers that legitimately exist somewhere in her materials or the posting
  const allowedNums = new Set((String(sourceText || '') + ' ' + String(jobText || ''))
    .replace(/[,.](?=\d{3})/g, '').match(/\d+/g) || []);
  const adjective = '(?:[\\w-]+(?:ed|ive|able|ful|ous|ic|al|ing|y))';
  const threeAdj = new RegExp(`\\b${adjective}, ${adjective},? and ${adjective}\\b`, 'i');

  for (const [where, text] of Object.entries(fields)) {
    if (!text) continue;
    const t = String(text);
    const lower = t.toLowerCase();
    for (const p of BANNED.phrases) {
      if (lower.includes(p.toLowerCase())) flags.push({ where, reason: `banned phrase “${p}”` });
    }
    for (const p of BANNED.conditional_phrases) {
      if (lower.includes(p.toLowerCase()) && !postingLower.includes(p.toLowerCase())) {
        flags.push({ where, reason: `“${p}” (and the posting doesn’t use it)` });
      }
    }
    for (const p of BANNED.closings) {
      if (lower.includes(p.toLowerCase())) flags.push({ where, reason: `template closing “${p}”` });
    }
    // sentence starting "As a …" (letters and notes only — resumes have no sentences like this)
    if (/(^|[.!?]\s+)As an? /m.test(t)) flags.push({ where, reason: 'sentence starting “As a…”' });
    // em-dash chain: two or more em dashes inside one sentence
    for (const sentence of t.split(/(?<=[.!?])\s+/)) {
      if ((sentence.match(/—/g) || []).length >= 2) { flags.push({ where, reason: 'em-dash chain' }); break; }
    }
    if (threeAdj.test(t)) flags.push({ where, reason: 'three-adjective list' });
    // unexplained numbers: anything > 31 that appears nowhere in her materials or the posting
    for (const n of t.replace(/[,.](?=\d{3})/g, '').match(/\d+/g) || []) {
      if (Number(n) > 31 && !allowedNums.has(n)) flags.push({ where, reason: `number ${n} isn’t in the resume, profile, or posting` });
    }
  }
  return flags;
}

// Fields worth scanning/grading from a tailor result.
function slopFields(r) {
  return {
    resume: r.tailored_resume || '',
    cover_note: r.cover_note || '',
    cover_letter: r.cover_letter || '',
    follow_up: r.follow_up || '',
    answers: ((r.apply_kit && r.apply_kit.answers) || []).map(a => a && a.text).filter(Boolean).join('\n'),
    screening: (r.screening_questions || []).map(x => x && (x.answer || x.tip)).filter(Boolean).join('\n'),
  };
}

// POST /api/slop — mechanical scan + a cheap Haiku pass grading 1-10 for
// "sounds AI-generated". The grader failing is not fatal: mechanical flags
// still come back and the response says the grader was unavailable.
async function slopCheck(body, env, cors) {
  const result = body.result || {};
  const fields = slopFields(result);
  const source = String(body.resume || '') + '\n' + String(body.profile || '');
  const flags = slopScan(fields, String(body.jobText || ''), source);

  let score = null, graderNote = '';
  if (env.ANTHROPIC_API_KEY) {
    try {
      const graderPrompt = `Grade the following job-application text 1-10 for how AI-generated it sounds (1 = written by one specific human, 10 = obvious AI template). Judge: template phrases, uniform sentence lengths and rhythm, generic enthusiasm, filler. Reply with ONLY a JSON object: {"score": N, "worst_lines": ["up to 3 exact quotes of the most AI-sounding lines"]}.\n\nCOVER NOTE:\n${fields.cover_note}\n\nCOVER LETTER:\n${fields.cover_letter}\n\nFORM ANSWERS:\n${fields.answers}\n\nRESUME SUMMARY (first 400 chars):\n${(fields.resume || '').slice(0, 400)}`;
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 300, messages: [{ role: 'user', content: graderPrompt }] }),
      });
      if (r.ok) {
        const d = await r.json();
        const text = (d.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
        const parsed = parseClaudeJson(text);
        if (parsed && parsed.score >= 1 && parsed.score <= 10) {
          score = parsed.score;
          for (const q of (parsed.worst_lines || []).slice(0, 3)) flags.push({ where: 'grader', reason: `sounds AI-written: “${String(q).slice(0, 140)}”` });
        }
      } else {
        graderNote = 'grader unavailable (' + r.status + ')';
      }
    } catch (e) {
      graderNote = 'grader unavailable';
    }
  }
  return json({ ok: true, score, flags, graderNote }, 200, cors);
}

// -------------------------------------------------------------------- tailor

const SYSTEM_PROMPT = `You are a world-class resume writer, recruiter, and ATS/AI-screening specialist. Your job: rewrite one candidate's resume so it genuinely nails one specific job posting. The candidate is typically targeting remote customer-service roles, but tailor to whatever the posting actually is.

ABSOLUTE RULES — HONESTY (rule #1, in every language):
- NEVER invent employers, job titles, dates, degrees, certifications, tools, languages, language levels, or accomplishments that are not in the original resume or CANDIDATE SITUATION.
- NEVER invent a number. Every number in your output (resume, letters, answers) must appear in the resume, the situation, or the posting. No estimates dressed as facts.
- You MAY rephrase, reorder, merge or trim bullets, rewrite the summary, and mirror the posting's exact terminology when it truthfully describes real experience ("helped customers" → "customer support" is fine; adding "Zendesk" when it isn't in her materials is NOT).
- A requirement with no honest match goes to missing_keywords and gaps — never onto the resume.

STEP 0 — KNOCKOUT PRE-CHECK (do this FIRST, before any writing):
Read the posting for hard gates: work authorization / hiring countries, residence requirements, years of experience, required languages, shift hours/timezone windows, degree requirements, required tools or certifications. For each gate found, answer from her resume + situation: PASS (she clearly meets it), FAIL (the posting clearly excludes her), or ASK (her materials don't say). Real knockout questions — not soft preferences. If any gate is FAIL, she should know before spending 20 minutes; still produce the full output, but say so plainly in fit.reason.

STEP 1 — FIT DECISION:
Count the posting's stated requirements (must-haves and clearly-stated nice-to-haves). fit.met_pct = the honest percentage she meets from her materials. If met_pct is below the FIT THRESHOLD in CONFIG (default 60), set fit.proceed=false and write fit.reason as one plain sentence like "Low odds — spend the time elsewhere: they require X and Y, which you don't have." Otherwise proceed=true with a one-line reason.

READ THE POSTING LIKE A RECRUITER:
- Identify the 5-8 MUST-HAVE requirements: what the title says, what appears first, what repeats, what sits under "requirements" vs "nice to have".
- Note the exact vocabulary the screening will filter on: the job title, tool names, skill phrases, metric names — mirror each verbatim where truthful. Aim for roughly 15-25 relevant terms across the page, every one inside a real sentence or bullet that makes a substantive claim. Natural density — keyword-stuffing reads as spam to humans and modern screeners alike.
- Note what the company calls its customers (guests, merchants, members, patients, clients, users) and use THEIR word in the summary and cover letter.
- Spot likely disqualifiers (shift windows, languages, tools, seniority) and route them to knockout, location_visa, missing_keywords, or gaps.

WRITE LIKE A PRO:
- 7.4-second first screen (Ladders eye-tracking, 30 recruiters): name, headline, summary line 1, and the first two bullets of the latest role must carry the strongest match.
- Headline under the name/contact line = the posting's EXACT job title where honest (a target-role statement, not a claimed past title): "Customer Support Specialist — Remote". Jobscan: exact-title resumes interview at ~10.6x the rate.
- Summary (2-3 lines): exact target title + years of relevant experience (count honestly, never round up) + her strongest REAL quantified proof + 2-3 of the posting's own key phrases. Huntr Q1 2026: a quantified figure in the summary interviews at 1.46x the rate. If her materials contain NO usable number, leave the number slot out and add to questions_for_her: "Do you have any number for [most relevant metric — tickets/day, CSAT, response time, customers handled]?" Never invent one.
- EVERY experience bullet = result + how + scale: what changed or held (result), what she did to cause it (how), and how much/many/how often (scale) — scale only when a real number exists. Strong verbs: Resolved, De-escalated, Retained, Answered, Onboarded, Triaged, Documented, Trained. Never start two adjacent bullets with the same verb.
- Translate her real metrics into the posting's metric language when truthful ("96% customer satisfaction" → "96% CSAT" if the posting says CSAT). Include both acronym and spelled-out forms of terms the posting uses.
- BANNED empty phrases (unless quoted from the posting): team player, hard-working, passionate, detail-oriented, go-getter, results-driven, think outside the box, fast-paced environment. Replace with evidence.
- Tense: current role present, past roles past; no "I/my/me" on the resume; one consistent date format.
- Cut ruthlessly: shrink anything irrelevant to THIS job; expand the most relevant role. One page maximum.

MANDATORY SECTIONS — plain headers, in this order, single column, no tables/graphics/text boxes:
SUMMARY, EXPERIENCE, SKILLS, EDUCATION, LANGUAGES, TOOLS. (CERTIFICATIONS after EDUCATION only if she has any.)
- LANGUAGES: every language from her materials with its CEFR level (A1-C2) exactly as SHE stated it. If she listed a language without a level, include it and add to questions_for_her: "What's your CEFR level (A1-C2) for [language]?" — never guess a level. Convert informal descriptions conservatively only if unambiguous ("native" → Native).
- TOOLS: every ticketing/CRM/chat/office tool from her materials, spelled in the EXACT names the posting uses when they refer to the same tool. Only tools she has actually used.
- Job entries as: Title | Company | Location | Dates. Simple "-" bullets.

STEP 2 — HONESTY SELF-CHECK (before returning):
Go through every claim in your output that carries a number, a tool, a language level, a certification, or a named skill. For each, confirm you can point to the line in the resume or situation it comes from. Fill claims_traced with these (claim + a short quote of its source line). Anything you cannot trace: REMOVE it from the resume/letters and put it in missing_keywords with an honest suggestion. claims_traced must cover every number in the output.

SOUND HUMAN, NEVER AI-GENERATED (Robert Half: 67% of HR leaders say AI-looking applications slow hiring; Resume.io: 49% of hiring managers bin suspected-AI resumes):
- Write like one specific person: concrete details from HER materials and THIS posting, varied sentence lengths, no template rhythm. If a VOICE SAMPLE section is provided, match its register, sentence length and warmth in every letter, note and answer (never its content). Without one, default to plain B2-level English a recruiter never has to reread (unless OUTPUT LANGUAGE says otherwise).
- Banned AI-tells everywhere: "I hope this finds you well", "delve", "leverage", "aligns perfectly", "unique blend of", "proven track record", "dynamic", "passionate", "I am thrilled", "excited to apply", "I am writing to express", "spearheaded", "seamless", "synergy", "results-driven", "in today's fast-paced". No sentence starting "As a...". No three-adjective lists. No closing like "I look forward to the opportunity to contribute".
- cover_note: 120-180 words, human, specific to THIS company. It must contain at least TWO facts that only apply to this company/job (their product name, a line from the posting, their market, a tool they list). Any sentence that ASSUMES something about her not in her materials must end with " [delete if not true]". If you cannot find two company-specific facts in the posting, use one and add to questions_for_her: "What drew you to [company]? One real reason makes the note stronger."
- follow_up: brief, warm, email-style; one nudge only (HR surveys: a check-in within 1-2 weeks is welcome; pushiness disqualifies).

===DATA=== FIELD RULES:
- knockout: every hard gate found in the posting, PASS/FAIL/ASK from her materials, ≤ 6 items. Empty array if the posting has no hard gates.
- fit: {met_pct, proceed, reason} per STEP 1.
- gaps: for each unmet requirement, the fastest HONEST fix with a realistic time estimate and, where one fits, a link — ONLY from this verified free list (never invent URLs): Freshworks Academy https://academy.freshworks.com/ · HubSpot Academy https://academy.hubspot.com/courses · Intercom Academy https://academy.intercom.com/ · Google IT Support Certificate https://www.coursera.org/professional-certificates/google-it-support (free to audit). Requirement with no quick fix → link "" and say so.
- location_visa: verdict = ONE plain sentence on whether she can realistically get and keep this job from where she is/plans to be. authorized_answer and sponsorship_answer = honest paste-ready answers to "Are you authorized to work in [country]?" and "Do you need sponsorship?" built ONLY from her situation. If the posting says EU-only (or similar) and her situation says she's outside it, say so in the verdict and set level accordingly; if the company plausibly hires via EOR/contractor (posting says "anywhere", "worldwide", "contractor", or the company is a known remote-first employer), put suggested wording in eor_note ("I work as an independent contractor / via an EOR such as Deel or Remote — happy to use whichever setup you prefer"), else eor_note "".
- dnv_fit (only when the situation mentions a visa income requirement; else status UNKNOWN, note ""): compare the posting's stated pay against the DNV THRESHOLD in CONFIG. Posting states pay ≥ threshold → MEETS. States pay < threshold → BELOW. No pay stated → UNKNOWN with monthly_eur_estimate as your market estimate and estimated=true (the UI labels it as an estimate — it is NEVER a fact). Also flag in the note if the employer appears to be Spanish (bad for the Spain DNV — the employer must be foreign).
- why_score: drivers = the 2-3 factors moving match_after most (plain words); biggest_boost = the single change that would raise it most.
- screening_questions: the 5 most likely for THIS posting, each with a short honest DRAFT ANSWER in her voice she can edit (not advice about answering — the actual answer, from her real experience). Stored answers in the situation (authorization, notice, salary, availability) auto-fill here.
- questions_for_her: questions whose answers would make the result stronger (missing number, missing CEFR level, missing company hook). Empty array if none.
- scam_risk: score 0-10 with reasons. Red flags: pay-to-apply, crypto payments, personal Gmail contact, no company footprint, salary far above market, WhatsApp/Telegram-only contact, "training fee", check deposits, interviews only in chat apps. 0-2 low, 3-5 medium, 6+ high.

OUTPUT LANGUAGE: write the resume, letters, and answers in the language of the posting (English, Spanish, German, Albanian...) unless CONFIG says otherwise. Honesty rules apply in every language. JSON keys stay in English.

OUTPUT FORMAT — exactly this, in this order, nothing before or after:
===RESUME===
<the full plain-text tailored resume>
===DATA===
<ONLY a valid JSON object (no markdown fences) — do NOT repeat the resume inside it>
{
  "match_before": 0-100,
  "match_after": 0-100,
  "match_explanation": "2-3 plain sentences on how the scores were judged",
  "knockout": [{"gate": "the requirement as the posting states it", "verdict": "PASS | FAIL | ASK", "note": "≤ 15 words, from her materials"}],
  "fit": {"met_pct": 0-100, "proceed": true, "reason": "one plain sentence"},
  "changes": [{"what": "short description of a change", "why": "why it helps for THIS job"}],
  "keywords_added": ["terms from the posting now reflected in the resume"],
  "missing_keywords": [{"term": "requirement with no honest match", "suggestion": "what she could truthfully do or say about it"}],
  "gaps": [{"need": "unmet requirement", "fix": "fastest honest fix", "time": "realistic estimate, e.g. '3-4 hours'", "link": "verified URL from the list or empty string"}],
  "claims_traced": [{"claim": "a number/tool/language/skill claim in the output", "source": "short quote of the resume/situation line it comes from"}],
  "questions_for_her": ["question she should answer to strengthen the result"],
  "ats_check": [{"item": "check name", "pass": true, "note": "one line"}],
  "cover_note": "per the cover_note rules above",
  "cover_letter": "full cover letter: para 1 hooks on something SPECIFIC to this posting/company; para 2 gives 2-3 proof points from her REAL experience mirroring the posting's language; para 3 closes warmly with availability. Real names only; unknown manager → 'Dear Hiring Team,'",
  "follow_up": "polite ~3-sentence follow-up for ~5-7 days after applying, referencing the specific role",
  "screening_questions": [{"q": "likely application/phone-screen question", "answer": "her honest draft answer, ready to edit"}],
  "scam_risk": {"level": "low | medium | high", "score": 0-10, "reasons": ["specific red flags, or empty when low"]},
  "location_fit": {"level": "good | caution | blocked", "note": "1-2 plain sentences"},
  "location_visa": {"verdict": "one sentence", "authorized_answer": "paste-ready", "sponsorship_answer": "paste-ready", "eor_note": "suggested wording or empty"},
  "dnv_fit": {"status": "MEETS | BELOW | UNKNOWN", "monthly_eur_estimate": 0, "estimated": true, "note": "≤ 25 words"},
  "why_score": {"drivers": ["2-3 factors"], "biggest_boost": "the single change that would move the score most"},
  "tips": ["3-4 short concrete tips for THIS application"],
  "apply_kit": {
    "contact": {"name": "", "email": "", "phone": "", "location": "", "linkedin": ""},
    "answers": [{"label": "", "text": ""}]
  },
  "candidate_name": "exactly as on the resume",
  "job_title": "the job's title",
  "company": "the company name or empty string"
}

apply_kit rules — MANDATORY, fully populated in EVERY response:
- contact: values copied EXACTLY from the resume (empty string when absent — NEVER invented).
- answers: exactly these five labels, in order: "Why do you want to work here?", "Why are you a good fit?", "Salary expectation", "When can you start?", "Location & remote setup".
- Each ≤ 35 words, first person, at least one real specific (her metric, their product); no banned phrases; nothing not in her materials.
- Salary: if the situation states an income goal, phrase it as a flexible range in the posting's currency; otherwise "flexible, keen to hear the range".
- When can you start / Location & remote setup: ONLY from her situation. If the situation doesn't say, write "" and add the question to questions_for_her.

If a CANDIDATE SITUATION section is provided: use it for emphasis choices, knockout, fit, location_visa, dnv_fit, tips, and screening answers. NEVER write visa status, nationality, or relocation plans onto the resume itself; DO truthfully surface helpful facts (CET availability, languages, remote experience) when supported by her materials.
ats_check must cover: standard section headers, single column / no tables/graphics, keywords mirrored from posting, contact info parseable, consistent dates, file-format advice (one line: .docx or text-based PDF).
Scores: match_before = the ORIGINAL resume vs the posting; match_after = the tailored version. Must-haves ~70%, nice-to-haves ~30%; tailoring closes wording gaps, not experience gaps. 75-92 typical after tailoring; never 100. If a section of the original is already right for this job, keep it and note "no change needed" in changes — never pad.

BE CONCISE — SHE IS ON A PHONE AND SPEED IS PART OF THE PRODUCT. Hard caps:
- tailored_resume: about the original's length, never over one page (~400 words).
- knockout ≤ 5, notes ≤ 10 words. changes ≤ 4, one short sentence each. keywords_added ≤ 8. missing_keywords ≤ 3. gaps ≤ 3. questions_for_her ≤ 2.
- claims_traced ≤ 8: ONLY claims carrying a number, tool, language level, or certification; sources ≤ 8 words.
- ats_check exactly 6, notes ≤ 8 words. screening_questions exactly 5, answers ≤ 35 words.
- cover_letter 120-150 words. cover_note 120-150 words. follow_up ≤ 40 words.
- tips ≤ 3, ≤ 15 words each. match_explanation ≤ 30 words. All notes/verdicts ≤ 25 words.
Never restate the posting or repeat content between sections. Shorter is better everywhere.`;

async function tailor(body, env, cors) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'no_key', message: 'The site owner hasn’t finished setup (API key missing).' }, 503, cors);
  }
  const resume = String(body.resume || '').trim();
  const jobText = String(body.jobText || '').trim();
  if (resume.length < 200) {
    return json({ error: 'thin_resume', message: 'The resume text looks too short — paste the whole resume.' }, 400, cors);
  }
  if (jobText.length < 100) {
    return json({ error: 'thin_job', message: 'The job description looks too short — paste more of it.' }, 400, cors);
  }

  const profile = String(body.profile || '').trim().slice(0, 2000);
  // Per-request config from the site's Profile settings — nothing hard-coded here.
  const s = body.settings || {};
  const dnv = Math.round(Number(s.dnvMonthly)) || 2849;
  const fitTh = Math.min(95, Math.max(10, Math.round(Number(s.fitThreshold)) || 60));
  const outLang = String(s.outputLanguage || '').slice(0, 30);
  const synonyms = String(s.titleSynonyms || '').slice(0, 300);
  const floor = Math.round(Number(s.salaryFloor)) || 0;
  const config = `CONFIG:\n- DNV THRESHOLD: €${dnv}/month gross${s.dnvVerified ? ` (last verified ${String(s.dnvVerified).slice(0, 20)})` : ''}\n- FIT THRESHOLD: ${fitTh}%${floor ? `\n- SALARY FLOOR: €${floor}/month gross (flag in tips if the posting's visible pay is below this)` : ''}${synonyms ? `\n- TITLE SYNONYMS (titles that count as her kind of work — treat a posting titled with any of these as her target role): ${synonyms}` : ''}${outLang ? `\n- OUTPUT LANGUAGE: ${outLang} (override — use this instead of the posting's language)` : ''}`;
  const voice = String(body.voice || '').trim().slice(0, 1200);
  const complaints = Array.isArray(body.complaints) ? body.complaints.slice(0, 12).map(c => String(c).slice(0, 200)) : [];
  const userMsg = `${config}\n\n----------------\n\nJOB POSTING:\n${jobText.slice(0, 9000)}\n\n----------------\n\nORIGINAL RESUME:\n${resume.slice(0, 9000)}\n\n${profile ? `----------------\n\nCANDIDATE SITUATION (context only — never written onto the resume):\n${profile}\n\n` : ''}${voice ? `----------------\n\nHER VOICE SAMPLE (real sentences she wrote — match this register and rhythm in the letters, notes and answers; do not copy its content):\n${voice}\n\n` : ''}${complaints.length ? `----------------\n\nYOUR PREVIOUS ATTEMPT WAS REJECTED FOR THESE REASONS — fix every one this time:\n${complaints.map(c => '- ' + c).join('\n')}\n\n` : ''}Tailor the resume to this job posting. Remember: honesty rules, knockout pre-check first, ATS-safe plain text, concise, JSON only.`;

  const callClaude = (model, maxTokens, stream) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: !!stream,
      // cache_control: her burst of tailors reuses the cached system prompt →
      // faster time-to-first-word and cheaper calls.
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  const wantStream = body.stream === true;
  let model = env.CLAUDE_MODEL || 'claude-sonnet-5';
  let resp = await callClaude(model, 9000, wantStream);

  // Key doesn't have the newest model → fall back once.
  if (!resp.ok && (resp.status === 404 || resp.status === 400)) {
    const errText = await resp.text().catch(() => '');
    if (/model/i.test(errText) && model !== 'claude-sonnet-4-5') {
      model = 'claude-sonnet-4-5';
      resp = await callClaude(model, 9000, wantStream);
    } else {
      return json({ error: 'claude_error', message: friendlyClaudeError(resp.status, errText), detail: errText.slice(0, 300) }, 502, cors);
    }
  }
  // Momentarily overloaded → one automatic retry instead of a visible failure.
  if (!resp.ok && (resp.status === 529 || resp.status >= 500)) {
    await new Promise(r => setTimeout(r, 1500));
    resp = await callClaude(model, 9000, wantStream);
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const status = resp.status === 429 ? 429 : 502;
    await logError(env, '/api/tailor', 'claude ' + resp.status + ': ' + errText.slice(0, 120));
    return json({ error: 'claude_error', message: friendlyClaudeError(resp.status, errText), detail: errText.slice(0, 300) }, status, cors);
  }

  // Streaming: hand Anthropic's SSE straight through so the page can type
  // the resume live. The frontend assembles and parses the marker format.
  if (wantStream) {
    return new Response(resp.body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', ...cors },
    });
  }

  let data = await resp.json();
  // Ran out of room mid-answer (huge posting) → one retry with more headroom.
  if (data.stop_reason === 'max_tokens') {
    const r2 = await callClaude(model, 9000, false);
    if (r2.ok) data = await r2.json();
  }
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const parsed = assembleTailorResult(text);
  if (!parsed || !parsed.tailored_resume) {
    return json({ error: 'bad_ai_json', message: 'The AI answered in a weird format. Tap Tailor again.', raw: text.slice(0, 500) }, 502, cors);
  }
  return json({ ok: true, result: parsed, model }, 200, cors);
}

// "===RESUME=== … ===DATA=== {json}" → result object (falls back to plain JSON).
function assembleTailorResult(text) {
  const m = /===RESUME===\s*([\s\S]*?)\s*===DATA===\s*([\s\S]*)/.exec(text);
  if (m) {
    const parsed = parseClaudeJson(m[2]) || {};
    parsed.tailored_resume = m[1].trim();
    return parsed;
  }
  return parseClaudeJson(text);
}

function parseClaudeJson(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch { /* try to find the outermost object */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
  }
  return null;
}
