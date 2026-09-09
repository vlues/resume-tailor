# Resume Tailor ✂️

Phone-friendly one-page site: paste a **job link** (or the job description) plus your **resume**, and Claude rewrites the resume *for that exact job* — honestly, in ATS-safe plain formatting — with:

- **Match score** — before vs. after tailoring, with the reasoning
- **What changed & why** — every edit explained
- **Keywords added** from the posting, and **requirements it couldn't honestly claim** (nothing is ever made up)
- **ATS check** — section headers, formatting, parseability, file-format advice
- **Cover note** — a short paste-ready message for the application

The resume is saved in the phone's browser (localStorage) so it's a one-time paste; every job after that is just *paste link → Tailor*. Copy button + Word/.txt downloads for the result.

## How it works

- **Frontend** — `index.html`, static, hosted on GitHub Pages: https://vlues.github.io/resume-tailor/
- **Backend** — Cloudflare Worker (`worker/`) at `resume-tailor-api.streamedmusics.workers.dev`:
  - `GET /api/jobs` — "found for you" feed: Remotive + RemoteOK + WeWorkRemotely, filtered to customer-service titles and Europe/anywhere-friendly locations, newest first (15-min upstream cache). Tapping a job on the site auto-tailors.
  - `POST /api/fetch-job` — reads a job URL: dedicated adapters (Greenhouse boards-api, Lever postings API, SmartRecruiters API, LinkedIn jobs-guest), then schema.org `JobPosting` JSON-LD, then main-content text; guides the user to paste the description when a site blocks robots (LinkedIn/Indeed block datacenter IPs).
  - `POST /api/tailor` — job + resume + saved "situation" (defaults to Kosovo → Spain digital-nomad-visa plan) → Claude with strict honesty + ATS/AI-screener rules. Returns tailored resume, before/after match scores, changes, keywords, ATS checklist, location-fit verdict, scam-risk flag, screening questions with answer tips, cover note, full cover letter, follow-up message, and per-job tips.
- The Anthropic key lives **only** in the Worker as a secret. Optional `ACCESS_CODE` gates the API (the site shows a code box only when one is set).

## Evidence behind the tactics

Every source below was opened and checked on **2026-09-09**. Rules of the list: primary sources where they exist, the caveat stays attached to the stat, and nothing cites the debunked "75% of resumes are rejected by ATS" number (it traces to a 2012 sales pitch from a defunct vendor — no study exists).

**Tailoring & volume (Huntr platform data)**
- **Tailored resumes interview at 4.23% vs 2.07% untailored** (139,927 applications, 25,635 job seekers, Q1 2026) — [Huntr Q1 2026 job-search trends](https://huntr.co/research/job-search-trends-q1-2026) ✅ verified
- **Volume kills quality: 11–20 applications → 9.25% interview rate; 100+ → 2.58%; ~48% of offer-getters got there within 30 applications; median search-to-offer 108 days (Q1 2026)** — same Huntr report ✅ verified
- **A quantified figure in the summary → 1.46× interview rate** (6.97% vs 4.78%) — same Huntr report ✅ verified
- **Job-board conversion: Google Jobs 6.6% vs LinkedIn 1.95% (~3.4×); 72.5% of surveyed seekers got zero interviews from Easy Apply; on Indeed sort by date and apply in the first days** (1.24M tracked applications) — [Huntr best job boards](https://huntr.co/research/best-job-boards) ✅ verified
- **ATS share of tracked applications (Q1 2026): Greenhouse 23.73%, Workday 21.72%, Ashby 15.41%** — Huntr data via [ApplyMate](https://apply-mate.com/blog/ats-statistics) (secondary; primary is the Huntr report above)

**How screening actually works**
- **92% of recruiters (23 of 25, 10+ ATS platforms, interviewed Sep–Oct 2025) say the ATS does NOT auto-reject on content or formatting; 100% use knockout questions when present** — [Enhancv recruiter study](https://enhancv.com/blog/does-ats-reject-resumes/) ✅ verified. ⚠️ Caveat: this study does **not** support "tables/columns/graphics cause parse failures" — it says formatting doesn't trigger auto-rejection and heavy graphics are a *human-reviewer* turn-off. Plain single-column output remains this tool's default as safe hygiene, not as a cited claim.
- **7.4-second average first screen; layout, titles, headings and keywords carry it** — [Ladders 2018 press release](https://www.prnewswire.com/news-releases/ladders-updates-popular-recruiter-eye-tracking-study-with-new-key-insights-on-how-job-seekers-can-improve-their-resumes-300744217.html) (the primary PDF now bot-blocks fetchers). ⚠️ Small study: 30 recruiters.
- **Exact job title on the resume ≈ 10.6× interview rate** — [Jobscan (primary)](https://www.jobscan.co/blog/top-resume-keywords-boost-resume/) ✅ verified

**Human-sounding text**
- **49% of US hiring managers auto-dismiss resumes they suspect are AI-written** (n=3,000, Jan 2025) — [Resume.io](https://resume.io/blog/resume-rejections); **62% reject AI resumes lacking personalization** (n=925) — [Resume Now](https://www.resume-now.com/job-resources/careers/ai-applicant-report)
- **But AI *editing* of human text raised hires ~8%** (480,948 job seekers, field experiment) — [NBER WP 30886, Wiles/Munyikwa/Horton 2023](https://www.nber.org/papers/w30886) ✅ verified
- **67% of HR leaders say AI-generated applications slow hiring** — [Robert Half, 2026](https://www.prnewswire.com/news-releases/robert-half-survey-67-of-hr-leaders-report-ai-generated-applications-are-slowing-hiring-302709410.html) ✅ verified

**Cover letters, follow-ups, referrals, timing**
- **Tailored cover letters: 16.4% vs 10.7% callback (+53%)** (7,287 applications; exact percentages appear in the results chart, +53% in the text) — [ResumeGo field experiment](https://www.resumego.net/research/cover-letters/) ✅ verified
- **Follow-ups welcome within 1–2 weeks (36% say that's the right window); email preferred 64% vs phone 21%** — [Accountemps/Robert Half](https://www.prnewswire.com/news-releases/the-art-of-following-up-300521814.html) ✅ verified
- **Referrals: ~7% of applicants but 30–50% of hires** — [Zippia](https://www.zippia.com/advice/employee-referral-statistics/) ✅ verified. ⚠️ The "email the hiring manager 3–5 days after applying" tactic has **no study behind it** — it's practitioner advice and is labeled as such in the tool.
- **Typical employer time-to-fill ≈ 42 days** (2,048 respondents) — [SHRM Human Capital Benchmarking](https://www.shrm.org/topics-tools/news/shrm-benchmarking-report-4129-average-cost-per-hire) (2016 report; SHRM's 2025 data reports the same 42-day average) ✅ verified 2026-09-09 — used in the Stats tab so silence doesn't read as rejection
- ❌ **Apply-within-96-hours ≈ 8× (TalentWorks)** — the primary is **dead** (talent.works redirects to a lander; company defunct). Secondaries preserve the stat but it can no longer be verified, so the site no longer states it as a number; freshness still matters per Huntr's Indeed finding above.

**Kosovo → Spain (digital-nomad visa, checked 2026-09-09)**
- **DNV income floor €2,849/month (€34,188/yr) = 200% of the 2026 SMI; ≥3 months with the foreign employer; employer ≥1 year old; ≤20% of income from Spanish companies; degree OR 3+ years' experience; applying from inside Spain → 3-year permit vs 1-year consular visa** — official scheme page: [prie.comercio.gob.es (teletrabajadores de carácter internacional)](https://prie.comercio.gob.es/es-es/Paginas/Teletrabajadores-caracter-internacional.aspx) (confirms the rules but prints no euro figure; €2,849 = 200% × 2026 SMI per Royal Decree 126/2026, corroborated by [movingtospain.com](https://movingtospain.com/spain-digital-nomad-visa/) and [hilivsolution.com](https://www.hilivsolution.com/blog/articles/spain-digital-nomad-visa))
- **Kosovo is not EU/Schengen; employers hire there via EOR or contractor** — [RemotePeople](https://remotepeople.com/countries/kosovo/employer-of-record/) (⚠️ names its own EOR service, not Deel/Remote/Native Teams — vendor names are common knowledge, not from this source)
- **EU remote-support screening: two working languages with CEFR levels, ticketing-tool fluency (Zendesk, Intercom, Front, Freshdesk, HubSpot Service Hub); named 2026 employers Hostinger, HubSpot, Klarna, Wise, Monzo, Booking.com** — [remoteworkeurope.eu](https://remoteworkeurope.eu/insights/bilingual-customer-service-jobs-europe/); **a second European language adds €3–8k** — [euremotejobs.com](https://euremotejobs.com/jobs/remote-customer-support-jobs/) ✅ verified (each half on its own page)

## Setup (one time)

```bash
./setup-api.sh
```

It prompts for the Anthropic API key (and an optional access code), stores them as Cloudflare secrets, and deploys the Worker. Run again any time to rotate.

## Deploying site changes

Push to `main` — GitHub Pages serves the repo root (`.nojekyll` present). Pages caches ~10 min.
