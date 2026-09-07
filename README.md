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

## Setup (one time)

```bash
./setup-api.sh
```

It prompts for the Anthropic API key (and an optional access code), stores them as Cloudflare secrets, and deploys the Worker. Run again any time to rotate.

## Deploying site changes

Push to `main` — GitHub Pages serves the repo root (`.nojekyll` present). Pages caches ~10 min.
