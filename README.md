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

The tailoring rules aren't folklore — each maps to published data:

- **7.4-second first screen; simple layout, clear headings, bold titles, bullets win** — [Ladders eye-tracking study, 2018 (primary PDF)](https://www.theladders.com/static/images/basicSite/pdfs/TheLadders-EyeTracking-StudyC2.pdf)
- **Exact job title on the resume ≈ 10.6× interview rate** — Jobscan platform data ([summary](https://blog.theinterviewguys.com/resume-title-examples/))
- **Tailored cover letters: 16.4% vs 10.7% callback (+53% at 30 days)** — [ResumeGo field experiment, 7,000+ applications](https://www.resumego.net/research/cover-letters/)
- **Apply within 96 hours ≈ 8× interview likelihood** — [TalentWorks analysis (primary post)](https://talent.works/2017/09/28/getting-ghosted-on-your-job-applications-heres-fix-1-apply-within-96-hours/)
- **Follow-ups: HR managers unanimously welcome a check-in, most within 1–2 weeks; email preferred; pushiness disqualifies** — [Accountemps/Robert Half surveys](https://www.prnewswire.com/news-releases/the-art-of-following-up-300521814.html)
- **67% of HR leaders say AI-generated applications slow hiring (2026) → letters must read human and specific** — [Robert Half, March 2026](https://www.prnewswire.com/news-releases/robert-half-survey-67-of-hr-leaders-report-ai-generated-applications-are-slowing-hiring-302709410.html)

## Setup (one time)

```bash
./setup-api.sh
```

It prompts for the Anthropic API key (and an optional access code), stores them as Cloudflare secrets, and deploys the Worker. Run again any time to rotate.

## Deploying site changes

Push to `main` — GitHub Pages serves the repo root (`.nojekyll` present). Pages caches ~10 min.
