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

      if (request.method !== 'POST') {
        return json({ error: 'Not found' }, 404, cors);
      }

      const body = await request.json().catch(() => ({}));

      // Access code gate (same pattern as the other sites)
      if (env.ACCESS_CODE && body.accessCode !== env.ACCESS_CODE) {
        return json({ error: 'bad_code', message: 'That access code isn’t right.' }, 401, cors);
      }

      if (url.pathname === '/api/fetch-job') {
        return await fetchJob(body, cors);
      }
      if (url.pathname === '/api/tailor') {
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
    return json({
      error: 'thin_page',
      message: 'That site hides the job details from robots. Copy the job description text and paste it instead — works every time.',
    }, 422, cors);
  }
  // Cap so a giant page doesn't blow the prompt.
  return json({ jobText: text.slice(0, 20000), title: titleFrom(html), company: '', source: 'page' }, 200, cors);
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
  "job_title": "the job's title",
  "company": "the company name or empty string"
}

ats_check must cover at least: standard section headers, no tables/columns/graphics, standard fonts implied by plain text, keywords mirrored from posting, contact info present and parseable, dates in consistent format, file-format advice (one line recommending .docx or PDF-with-text upload).
Scores: match_before = how well the ORIGINAL resume matches the posting's requirements; match_after = the tailored version. Be honest — after tailoring, 75-92 is typical; only exceed that when the fit is genuinely excellent. Never claim 100.`;

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

  const userMsg = `JOB POSTING:\n${jobText.slice(0, 20000)}\n\n----------------\n\nORIGINAL RESUME:\n${resume.slice(0, 15000)}\n\nTailor the resume to this job posting. Remember: honesty rules, ATS-safe plain text, JSON only.`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || 'claude-sonnet-4-5',
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const status = resp.status === 429 ? 429 : 502;
    const message = resp.status === 429
      ? 'The AI is a little busy — wait a few seconds and tap Tailor again.'
      : 'The AI hit a snag. Try again in a moment.';
    return json({ error: 'claude_error', message, detail: errText.slice(0, 300) }, status, cors);
  }

  const data = await resp.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const parsed = parseClaudeJson(text);
  if (!parsed || !parsed.tailored_resume) {
    return json({ error: 'bad_ai_json', message: 'The AI answered in a weird format. Tap Tailor again.', raw: text.slice(0, 500) }, 502, cors);
  }
  return json({ ok: true, result: parsed }, 200, cors);
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
