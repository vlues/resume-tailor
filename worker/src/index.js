// Resume Tailor API — Cloudflare Worker
// Endpoints:
//   GET  /api/health          → { ok, hasKey, needsCode }
//   POST /api/fetch-job       → { jobText, title, company, source } (reads a job posting URL)
//   POST /api/tailor          → tailored resume JSON (calls Claude)
//
// Secrets (wrangler secret put): ANTHROPIC_API_KEY (required), ACCESS_CODE (optional)

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
        return await jobsFeed(cors);
      }

      if (request.method !== 'POST') {
        return json({ error: 'Not found' }, 404, cors);
      }

      const body = await request.json().catch(() => ({}));

      if (url.pathname === '/api/fetch-job') {
        return await fetchJob(body, cors);
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
      return json({ error: 'server_error', message: String(err && err.message || err) }, 500, cors);
    }
  },
};

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

const LOCATION_OK = /worldwide|anywhere|global|international|europe|emea|remote[- ]?first|kosovo|spain|utc|cet|balkan/i;
const TITLE_OK = /customer|support|success|service|helpdesk|help desk|client|community|care|happiness/i;
const US_ONLY = /U\.?S\.?[- .]?based|USA only|US only|United States only|Canada only/i;
const FEED_CACHE_KEY = 'https://resume-tailor.internal/jobs-feed-v5';
const UA = { 'User-Agent': 'ResumeTailor/1.0' };
const CF_CACHE = { cf: { cacheTtl: 900, cacheEverything: true } };

async function jobsFeed(cors) {
  // Whole-feed cache: repeat loads within 10 minutes are instant.
  const cache = caches.default;
  const hit = await cache.match(FEED_CACHE_KEY).catch(() => null);
  if (hit) {
    const body = await hit.text();
    return new Response(body, { status: 200, headers: { ...JSON_HEADERS, ...cors } });
  }

  // All sources in parallel; any one failing is fine.
  const results = await Promise.allSettled([
    fetchRemotive(), fetchRemoteOK(), fetchWWR(),
    fetchJobicy('europe'), fetchJobicy('anywhere'),
    fetchJobicy('europe', 'customer'), fetchJobicy('anywhere', 'customer'),
    ...GH_BOARDS.map(fetchGreenhouseBoard),
    ...ASHBY_BOARDS.map(fetchAshbyBoard),
  ]);
  const jobs = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // Rank by "landable for her": entry/mid support roles first, senior
  // leadership down, work-from-anywhere and posted-salary up, fresher up.
  const now = Date.now();
  for (const j of jobs) {
    let s = 0;
    const t = j.title || '', loc = j.location || '';
    const days = Math.max(0, (now - new Date(j.date).getTime()) / 86400000) || 10;
    s -= Math.min(days, 30) * 1.5;
    if (/anywhere|worldwide|global/i.test(loc)) s += 8;
    else if (/emea|europe/i.test(loc)) s += 6;
    if (j.salary) s += 3;
    if (/director|head of|vp|vice president|principal|\blead\b|manager,? (of|customer success managers)/i.test(t)) s -= 14;
    else if (/senior|\bsr\.?\b|staff\b/i.test(t)) s -= 6;
    if (/representative|specialist|associate|agent|advocate|advisor|coordinator|analyst|support engineer/i.test(t)) s += 5;
    j._score = s;
  }
  jobs.sort((a, b) => b._score - a._score || new Date(b.date) - new Date(a.date));
  const seen = new Set();
  const out = [];
  for (const j of jobs) {
    const k = (j.company + '|' + j.title).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    delete j._score;
    out.push(j);
    if (out.length >= 60) break;
  }

  const body = JSON.stringify({ ok: true, jobs: out });
  if (out.length >= 5) {
    await cache.put(FEED_CACHE_KEY, new Response(body, {
      headers: { 'content-type': 'application/json', 'Cache-Control': 'public, max-age=600' },
    })).catch(() => {});
  }
  return new Response(body, { status: 200, headers: { ...JSON_HEADERS, ...cors } });
}

// Remotive: public API with candidate_required_location (its category param is
// unreliable — filter on the response's fields instead)
async function fetchRemotive() {
  const jobs = [];
  const r = await fetch('https://remotive.com/api/remote-jobs?search=customer%20support&limit=100', CF_CACHE);
  if (!r.ok) return jobs;
  const d = await r.json();
  for (const j of d.jobs || []) {
    if (!TITLE_OK.test((j.title || '') + ' ' + (j.category || ''))) continue;
    const loc = j.candidate_required_location || '';
    if (loc && !LOCATION_OK.test(loc)) continue;
    if (US_ONLY.test((j.title || '') + ' ' + loc)) continue;
    jobs.push({
      title: j.title, company: j.company_name, url: j.url,
      location: loc || 'Not specified', date: j.publication_date,
      salary: j.salary || '', source: 'Remotive',
    });
  }
  return jobs;
}

// RemoteOK: public API; first element is a legal notice
async function fetchRemoteOK() {
  const jobs = [];
  const r = await fetch('https://remoteok.com/api?tags=customer%20support', { headers: UA, ...CF_CACHE });
  if (!r.ok) return jobs;
  const d = await r.json();
  for (const j of (Array.isArray(d) ? d : [])) {
    if (!j || !j.position || !j.url) continue;
    if (!TITLE_OK.test(j.position)) continue;
    const loc = j.location || '';
    if (loc && !LOCATION_OK.test(loc)) continue;
    if (US_ONLY.test(j.position + ' ' + loc)) continue;
    const salary = j.salary_min ? `$${Math.round(j.salary_min/1000)}k–$${Math.round((j.salary_max||j.salary_min)/1000)}k` : '';
    jobs.push({
      title: j.position, company: j.company, url: j.url,
      location: loc || 'Not specified', date: j.date, salary, source: 'RemoteOK',
    });
  }
  return jobs;
}

// We Work Remotely: customer-support RSS
async function fetchWWR() {
  const jobs = [];
  const r = await fetch('https://weworkremotely.com/categories/remote-customer-support-jobs.rss', { headers: UA, ...CF_CACHE });
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
    if (!TITLE_OK.test(title)) continue;
    if (US_ONLY.test(title + ' ' + region)) continue;
    const sal = /\$\s?\d[\d,.]*k?(?:\s?[-–]\s?\$?\d[\d,.]*k?)?(?:\s?\/\s?(?:year|yr|month|mo|hour|hr))?/i.exec(title);
    title = title.split(/ — | – | \(|\||,? \$/)[0].replace(/[-–—\s]+$/, '').trim() || title;
    jobs.push({ title, company: company || '', url: link, location: region, date, salary: sal ? sal[0].replace(/\s+/g, '') : '', source: 'WeWorkRemotely' });
  }
  return jobs;
}

// Direct company boards (Greenhouse public API) — companies that hire remote
// support at volume; the most legit listings there are.
const GH_BOARDS = ['gitlab', 'remotecom', 'canonical', 'wikimedia'];
const GH_LOC_OK = /emea|europe|world|anywhere|global/i;

async function fetchGreenhouseBoard(board) {
  const jobs = [];
  const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs`, { headers: UA, ...CF_CACHE });
  if (!r.ok) return jobs;
  const d = await r.json();
  for (const j of d.jobs || []) {
    if (!TITLE_OK.test(j.title || '')) continue;
    const loc = (j.location && j.location.name) || '';
    if (!GH_LOC_OK.test(loc + ' ' + j.title)) continue;
    if (US_ONLY.test(j.title + ' ' + loc)) continue;
    jobs.push({
      title: j.title, company: board === 'remotecom' ? 'Remote.com' : board.charAt(0).toUpperCase() + board.slice(1),
      url: j.absolute_url, location: loc || 'Remote', date: j.updated_at || j.first_published,
      salary: '', source: 'Company board',
    });
  }
  return jobs;
}

// Ashby public posting API — more direct company boards with EMEA support roles.
const ASHBY_BOARDS = ['posthog', 'supabase'];

async function fetchAshbyBoard(board) {
  const jobs = [];
  const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${board}`, { headers: UA, ...CF_CACHE });
  if (!r.ok) return jobs;
  const d = await r.json();
  for (const j of d.jobs || []) {
    if (!TITLE_OK.test(j.title || '')) continue;
    const loc = [j.location, ...((j.secondaryLocations || []).map(x => x.location))].filter(Boolean).join('; ');
    if (!/emea|europe|world|anywhere|global/i.test(loc + ' ' + j.title)) continue;
    if (US_ONLY.test(j.title + ' ' + loc)) continue;
    jobs.push({
      title: j.title, company: board.charAt(0).toUpperCase() + board.slice(1),
      url: j.jobUrl || j.applyUrl, location: loc || 'Remote', date: j.publishedAt,
      salary: '', source: 'Company board',
    });
  }
  return jobs;
}

// Jobicy: public API with region + industry/tag filters (credit: jobicy.com)
async function fetchJobicy(geo, tag) {
  const jobs = [];
  const filter = tag ? `tag=${tag}` : 'industry=supporting';
  const r = await fetch(`https://jobicy.com/api/v2/remote-jobs?count=50&geo=${geo}&${filter}`, { headers: UA, ...CF_CACHE });
  if (!r.ok) return jobs;
  const d = await r.json();
  for (const j of d.jobs || []) {
    if (!j.jobTitle || !j.url) continue;
    if (!TITLE_OK.test(j.jobTitle)) continue;
    const loc = Array.isArray(j.jobGeo) ? j.jobGeo.join(', ') : (j.jobGeo || '');
    if (loc && !LOCATION_OK.test(loc)) continue;
    if (US_ONLY.test(j.jobTitle + ' ' + loc)) continue;
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
    const resp = await fetch(jobUrl, {
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
        const r = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, {
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
        const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`);
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
        const r = await fetch(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`);
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
        const r = await fetch(`https://api.smartrecruiters.com/v1/companies/${m[1]}/postings/${m[2]}`);
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

// -------------------------------------------------------------------- tailor

const SYSTEM_PROMPT = `You are a world-class resume writer, recruiter, and ATS/AI-screening specialist. Your job: rewrite one candidate's resume so it genuinely nails one specific job posting. The candidate is typically targeting remote customer-service roles, but tailor to whatever the posting actually is.

ABSOLUTE RULES — HONESTY:
- NEVER invent employers, job titles, dates, degrees, certifications, tools, or accomplishments that are not in the original resume.
- You MAY rephrase, reorder, quantify only with numbers already present, merge or trim bullets, rewrite the summary, and mirror the job posting's exact terminology when it truthfully describes the candidate's real experience (e.g. "helped customers" → "customer support" is fine; adding "Zendesk" when it isn't in the resume is NOT).
- If an important job requirement has no honest match in the resume, list it in missing_keywords instead of faking it.

READ THE POSTING LIKE A RECRUITER (do this analysis before writing):
- Identify the 5-8 MUST-HAVE requirements: what the title says, what appears first, what repeats, what sits under "requirements" vs "nice to have". These drive everything.
- Note the exact vocabulary the ATS will filter on: the job title, tool names, skill phrases, metric names — and mirror each one verbatim where truthful.
- Note what the company calls its customers (guests, merchants, members, patients, clients, users) and use THEIR word in the summary and cover letter.
- Note the posting's tone and values (e.g. "empathy", "ownership", "async communication") and let the resume's real content demonstrate them — never just declare them.
- Spot likely disqualifiers (shift windows, languages, tools, seniority) and route them to location_fit, missing_keywords, or tips.

WRITE LIKE A PRO (this is what "best words" means):
- 7.4-second test (Ladders eye-tracking, 2018): a recruiter's first screen averages 7.4 seconds and lands on layout, job titles, section headings, and keywords. Name, headline, summary line 1, and the first two bullets of the latest role must carry the strongest match; clear ALL-CAPS section headers and bulleted accomplishments are what scanning eyes follow.
- Headline under the name/contact line = the posting's EXACT job title (target-role statement, not a claimed past title): "Customer Support Specialist — Remote". Jobscan platform data: exact-title resumes interview at ~10x the rate.
- Summary formula (2-3 lines): exact target title + years of relevant experience + strongest quantified proof + 2-3 of the posting's own key phrases + remote-readiness.
- Bullet formula: strong verb + specific task + real number/outcome. Verbs that work in support: Resolved, De-escalated, Retained, Answered, Onboarded, Triaged, Documented, Maintained, Trained, Achieved. Never start two adjacent bullets with the same verb.
- Translate her real metrics into the posting's metric language when truthful: "96% customer satisfaction" → "96% CSAT" if the posting says CSAT; calls/chats per day, first-response time, resolution rate, QA score, retention.
- Include both acronym and spelled-out forms of any term the posting uses (CRM / customer relationship management).
- BANNED empty phrases (unless quoted from the posting): team player, hard-working, passionate, detail-oriented, go-getter, results-driven, think outside the box, fast-paced environment. Replace with evidence.
- Tense: current role in present tense, past roles in past tense; no "I/my/me" anywhere on the resume; consistent date format throughout.
- Modern screeners score MEANING, not just keywords: state the top requirements both in the posting's exact words AND once in a natural restatement. Keyword-stuffing and hidden text get applications rejected — every keyword must live inside a substantive claim.
- Cut ruthlessly: remove or shrink anything irrelevant to THIS job; expand the most relevant role instead. Strongest material first in every section.
- For remote roles: truthfully surface remote signals — written communication, self-managed work, home-office setup, timezone/schedule flexibility.

SOUND HUMAN, NEVER AI-GENERATED (Robert Half 2026: 67% of HR leaders say AI-generated applications are slowing hiring — recruiters now actively discard generic AI text):
- Write like one specific person: concrete details from HER resume and THIS posting, varied sentence lengths, no template rhythm.
- Banned AI-tells in letters and notes: "I hope this finds you well", "delve", "leverage", "aligns perfectly", "unique blend of", "proven track record", "dynamic", "passionate about delivering", "I am thrilled".
- The cover letter and note must each contain at least one detail only THIS candidate could truthfully write (a real number or situation from her resume) and one detail specific to THIS company or role.
- follow_up: brief, warm, email-style; one nudge only — surveys show HR managers welcome a check-in within 1-2 weeks but reject pushiness.

ATS-SAFE OUTPUT:
- Plain text only: no tables, columns, text boxes, images, emoji, or special glyphs. Standard section headers (SUMMARY, SKILLS, EXPERIENCE, EDUCATION, CERTIFICATIONS). Simple "-" bullets. Job entries as: Title | Company | Location | Dates.
- Include the exact keywords/phrases from the posting (spelled the same way, including both the acronym and spelled-out form when relevant) wherever they are truthful.
- Keep it to roughly the same length as the original resume — one page-ish. Strongest, most relevant material first.

OUTPUT FORMAT — exactly this, in this order, nothing before or after:
===RESUME===
<the full plain-text tailored resume>
===DATA===
<ONLY a valid JSON object (no markdown fences) in exactly this shape — do NOT repeat the resume inside it>
{
  "match_before": 0-100,
  "match_after": 0-100,
  "match_explanation": "2-3 plain sentences on how the scores were judged",
  "changes": [{"what": "short description of a change", "why": "why it helps for THIS job"}],
  "keywords_added": ["terms from the posting now reflected in the resume"],
  "missing_keywords": [{"term": "requirement with no honest match", "suggestion": "what she could truthfully do or say about it"}],
  "ats_check": [{"item": "check name", "pass": true, "note": "one line"}],
  "cover_note": "3-4 sentences for an application's 'anything else' box: one concrete hook from the posting, her single strongest quantified proof, warm close. Never open with 'I am writing to apply'",
  "cover_letter": "a full cover letter for this job: paragraph 1 hooks on something SPECIFIC in this posting or company (their product, their customers, the role's core challenge); paragraph 2 gives 2-3 proof points from her REAL experience mirroring the posting's language with numbers; paragraph 3 closes warmly with availability. No placeholders like [Company] — use actual names; unknown manager → 'Dear Hiring Team,'. Banned openers: 'I am writing to apply', 'I am excited to apply'",
  "follow_up": "a polite 3-sentence follow-up message to send ~5-7 days after applying if she hasn't heard back, referencing the specific role",
  "screening_questions": [{"q": "(give 4-6) a question this employer will likely ask in the application form, phone screen, or first interview (base on the posting)", "tip": "how SHE should answer, using her real experience — include a concrete example from her resume where possible"}],
  "scam_risk": {"level": "low | medium | high", "reasons": ["only if medium/high: specific red flags seen in the posting — e.g. pay far above market, vague company, requests to buy equipment, interviews only via chat app, checks to deposit; empty array when low"]},
  "location_fit": {"level": "good | caution | blocked", "note": "1-2 plain sentences: given the CANDIDATE SITUATION (if provided), can she realistically get and keep this job? Check the posting for hiring-country/state restrictions ('US only', 'must reside in…', listed countries, timezone windows) and whether it fits her location plans. 'blocked' = the posting clearly excludes her location; 'caution' = unclear or partial fit — say what to check before spending time; 'good' = no location obstacle"},
  "tips": ["3-4 short, concrete tips for THIS specific application — e.g. what the screening will likely ask, which of her strengths to lead with if there's a phone screen, anything time-sensitive in the posting; if the application likely has an optional cover-letter field, tell her to use the tailored letter and reword one sentence in her own voice (tailored letters drew 53% more callbacks in ResumeGo's 7,000-application field study); if the CANDIDATE SITUATION states an income goal and the posting's visible pay falls short of it, say so plainly"],
  "apply_kit": {
    "contact": {"name": "", "email": "", "phone": "", "location": "", "linkedin": ""},
    "answers": [{"label": "", "text": ""}]
  },
  "candidate_name": "the candidate's name exactly as it appears on the resume",
  "job_title": "the job's title",
  "company": "the company name or empty string"
}

apply_kit rules — the copy-paste kit for the application form itself. MANDATORY: apply_kit must be present and fully populated in EVERY response — all five answers written, never empty, never omitted:
- contact: values copied EXACTLY from the resume (empty string when absent — NEVER invented).
- answers: exactly these five labels, in this order: "Why do you want to work here?", "Why are you a good fit?", "Salary expectation", "When can you start?", "Location & remote setup".
- Each answer ≤ 35 words, first person allowed, written per the SOUND HUMAN rules — at least one real specific (her metric, their product); no banned phrases.
- Salary: if the CANDIDATE SITUATION states an income goal, phrase it as a flexible range in the posting's currency ("I'm targeting around €X–Y gross monthly, flexible for the right role"); otherwise "flexible, keen to hear the range".
- Location & remote setup: her real location/timezone and remote readiness — never visa or relocation details.

If a CANDIDATE SITUATION section is provided: use it ONLY for emphasis choices, location_fit, tips, and screening answers. NEVER write visa status, nationality, or relocation plans into the resume itself; DO truthfully surface things that help her case (e.g. CET-timezone availability, language skills, work-from-anywhere readiness) if supported by the resume or situation.
ats_check must cover at least: standard section headers, no tables/columns/graphics, standard fonts implied by plain text, keywords mirrored from posting, contact info present and parseable, dates in consistent format, file-format advice (one line recommending .docx or PDF-with-text upload).
Scores: match_before = how well the ORIGINAL resume matches the posting's requirements; match_after = the tailored version. Weigh must-have requirements ~70%, nice-to-haves ~30%; tailoring can close wording gaps but not experience gaps. Be honest — after tailoring, 75-92 is typical; only exceed that when the fit is genuinely excellent. Never claim 100.

BE CONCISE — SHE IS ON A PHONE AND SPEED MATTERS. Hard caps:
- tailored_resume: about the original's length, never longer than one page (~450 words).
- changes: max 5, each "what" and "why" one short sentence.
- keywords_added: max 10. missing_keywords: max 4, suggestions ≤ 20 words.
- ats_check: exactly 6 items, notes ≤ 12 words.
- screening_questions: exactly 4, tips ≤ 30 words each.
- cover_letter: 130-170 words. cover_note: 3 sentences. follow_up: ≤ 45 words.
- tips: max 3, ≤ 20 words each. match_explanation: ≤ 35 words. location_fit note: ≤ 30 words. apply_kit answers: ≤ 35 words each.
No filler, no repetition between sections.`;

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
  const userMsg = `JOB POSTING:\n${jobText.slice(0, 16000)}\n\n----------------\n\nORIGINAL RESUME:\n${resume.slice(0, 12000)}\n\n${profile ? `----------------\n\nCANDIDATE SITUATION (context only — never written onto the resume):\n${profile}\n\n` : ''}Tailor the resume to this job posting. Remember: honesty rules, ATS-safe plain text, concise, JSON only.`;

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
