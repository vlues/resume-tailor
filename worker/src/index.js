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
        return json({ ok: true, hasKey: !!env.ANTHROPIC_API_KEY, needsCode: !!env.ACCESS_CODE }, 200, cors);
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

// ------------------------------------------------------------------ jobs feed

const LOCATION_OK = /worldwide|anywhere|global|international|europe|emea|remote[- ]?first|kosovo|spain|utc|cet|balkan/i;
const TITLE_OK = /customer|support|success|service|helpdesk|help desk|client|community|care|happiness/i;
const US_ONLY = /U\.?S\.?[- .]?based|USA only|US only|United States only|Canada only/i;
const FEED_CACHE_KEY = 'https://resume-tailor.internal/jobs-feed-v4';
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
  ]);
  const jobs = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

  // Newest first, dedupe by company+title, cap.
  jobs.sort((a, b) => new Date(b.date) - new Date(a.date));
  const seen = new Set();
  const out = [];
  for (const j of jobs) {
    const k = (j.company + '|' + j.title).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(j);
    if (out.length >= 50) break;
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

const SYSTEM_PROMPT = `You are an expert resume writer and ATS (applicant tracking system) specialist helping a candidate tailor their resume to one specific job posting. The candidate is targeting remote customer-service roles but tailor to whatever the posting actually is.

ABSOLUTE RULES — HONESTY:
- NEVER invent employers, job titles, dates, degrees, certifications, tools, or accomplishments that are not in the original resume.
- You MAY rephrase, reorder, quantify only with numbers already present, merge or trim bullets, rewrite the summary, and mirror the job posting's exact terminology when it truthfully describes the candidate's real experience (e.g. "helped customers" → "customer support" is fine; adding "Zendesk" when it isn't in the resume is NOT).
- If an important job requirement has no honest match in the resume, list it in missing_keywords instead of faking it.

OPTIMIZE FOR AI AND HUMAN SCREENERS (both skim):
- Directly under the candidate's name/contact line, add a headline with the posting's EXACT job title (resumes containing the exact title get ~10x more interviews). This is a target-role headline, not a claimed past title — e.g. "Customer Support Specialist — Remote".
- Front-load: the summary's first line and the first bullet of the most recent job must hit the posting's top requirement.
- Mirror the posting's exact phrasing for its top 5-8 requirements wherever truthful (e.g. if it says "customer success," don't only say "customer service").
- Include both acronym and spelled-out forms of any term the posting uses (CRM / customer relationship management).
- Quantify with real numbers already in the resume; a bullet with a number beats an adjective.
- One clean job title line per role; if the real title is unusual, keep it but add a truthful clarifier in the bullet, never a fake title.
- Remove or de-emphasize content irrelevant to THIS job rather than padding.
- For remote roles: surface anything that truthfully signals remote-readiness (self-managed work, written communication, home-office tools, schedule flexibility).

ATS-SAFE OUTPUT:
- Plain text only: no tables, columns, text boxes, images, emoji, or special glyphs. Standard section headers (SUMMARY, SKILLS, EXPERIENCE, EDUCATION, CERTIFICATIONS). Simple "-" bullets. Job entries as: Title | Company | Location | Dates.
- Include the exact keywords/phrases from the posting (spelled the same way, including both the acronym and spelled-out form when relevant) wherever they are truthful.
- Keep it to roughly the same length as the original resume — one page-ish. Strongest, most relevant material first.

Respond ONLY with valid JSON (no markdown fences) in exactly this shape:
{
  "tailored_resume": "full plain-text resume",
  "match_before": 0-100,
  "match_after": 0-100,
  "match_explanation": "2-3 plain sentences on how the scores were judged",
  "changes": [{"what": "short description of a change", "why": "why it helps for THIS job"}],
  "keywords_added": ["terms from the posting now reflected in the resume"],
  "missing_keywords": [{"term": "requirement with no honest match", "suggestion": "what she could truthfully do or say about it"}],
  "ats_check": [{"item": "check name", "pass": true, "note": "one line"}],
  "cover_note": "a short 3-4 sentence message she can paste into an application's 'anything else' box or a quick email, warm and specific to this job",
  "cover_letter": "a full cover letter (3 short paragraphs, ~180-250 words) for this job: hook tied to the company, 2-3 proof points from her REAL experience mirroring the posting's language, warm close. No placeholders like [Company] — use the actual names; if the hiring manager is unknown, open with 'Dear Hiring Team,'",
  "follow_up": "a polite 3-sentence follow-up message to send ~5-7 days after applying if she hasn't heard back, referencing the specific role",
  "screening_questions": [{"q": "(give 4-6) a question this employer will likely ask in the application form, phone screen, or first interview (base on the posting)", "tip": "how SHE should answer, using her real experience — include a concrete example from her resume where possible"}],
  "scam_risk": {"level": "low | medium | high", "reasons": ["only if medium/high: specific red flags seen in the posting — e.g. pay far above market, vague company, requests to buy equipment, interviews only via chat app, checks to deposit; empty array when low"]},
  "location_fit": {"level": "good | caution | blocked", "note": "1-2 plain sentences: given the CANDIDATE SITUATION (if provided), can she realistically get and keep this job? Check the posting for hiring-country/state restrictions ('US only', 'must reside in…', listed countries, timezone windows) and whether it fits her location plans. 'blocked' = the posting clearly excludes her location; 'caution' = unclear or partial fit — say what to check before spending time; 'good' = no location obstacle"},
  "tips": ["3-4 short, concrete tips for THIS specific application — e.g. what the screening will likely ask, which of her strengths to lead with if there's a phone screen, anything time-sensitive in the posting; if the CANDIDATE SITUATION states an income goal and the posting's visible pay falls short of it, say so plainly"],
  "candidate_name": "the candidate's name exactly as it appears on the resume",
  "job_title": "the job's title",
  "company": "the company name or empty string"
}

If a CANDIDATE SITUATION section is provided: use it ONLY for emphasis choices, location_fit, tips, and screening answers. NEVER write visa status, nationality, or relocation plans into the resume itself; DO truthfully surface things that help her case (e.g. CET-timezone availability, language skills, work-from-anywhere readiness) if supported by the resume or situation.
ats_check must cover at least: standard section headers, no tables/columns/graphics, standard fonts implied by plain text, keywords mirrored from posting, contact info present and parseable, dates in consistent format, file-format advice (one line recommending .docx or PDF-with-text upload).
Scores: match_before = how well the ORIGINAL resume matches the posting's requirements; match_after = the tailored version. Be honest — after tailoring, 75-92 is typical; only exceed that when the fit is genuinely excellent. Never claim 100.

BE CONCISE — SHE IS ON A PHONE AND SPEED MATTERS. Hard caps:
- tailored_resume: about the original's length, never longer than one page (~450 words).
- changes: max 5, each "what" and "why" one short sentence.
- keywords_added: max 10. missing_keywords: max 4, suggestions ≤ 20 words.
- ats_check: exactly 6 items, notes ≤ 12 words.
- screening_questions: exactly 4, tips ≤ 30 words each.
- cover_letter: 130-170 words. cover_note: 3 sentences. follow_up: ≤ 45 words.
- tips: max 3, ≤ 20 words each. match_explanation: ≤ 35 words. location_fit note: ≤ 30 words.
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

  const callClaude = (model, maxTokens) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  let model = env.CLAUDE_MODEL || 'claude-sonnet-5';
  let resp = await callClaude(model, 5000);

  // Key doesn't have the newest model → fall back once.
  if (!resp.ok && (resp.status === 404 || resp.status === 400)) {
    const errText = await resp.text().catch(() => '');
    if (/model/i.test(errText) && model !== 'claude-sonnet-4-5') {
      model = 'claude-sonnet-4-5';
      resp = await callClaude(model, 5000);
    } else {
      return json({ error: 'claude_error', message: 'The AI hit a snag. Try again in a moment.', detail: errText.slice(0, 300) }, 502, cors);
    }
  }
  // Momentarily overloaded → one automatic retry instead of a visible failure.
  if (!resp.ok && (resp.status === 529 || resp.status >= 500)) {
    await new Promise(r => setTimeout(r, 1500));
    resp = await callClaude(model, 5000);
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const status = resp.status === 429 ? 429 : 502;
    const message = resp.status === 429
      ? 'The AI is a little busy — wait a few seconds and tap Tailor again.'
      : 'The AI hit a snag. Try again in a moment.';
    return json({ error: 'claude_error', message, detail: errText.slice(0, 300) }, status, cors);
  }

  let data = await resp.json();
  // Ran out of room mid-answer (huge posting) → one retry with more headroom.
  if (data.stop_reason === 'max_tokens') {
    const r2 = await callClaude(model, 9000);
    if (r2.ok) data = await r2.json();
  }
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const parsed = parseClaudeJson(text);
  if (!parsed || !parsed.tailored_resume) {
    return json({ error: 'bad_ai_json', message: 'The AI answered in a weird format. Tap Tailor again.', raw: text.slice(0, 500) }, 502, cors);
  }
  return json({ ok: true, result: parsed, model }, 200, cors);
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
