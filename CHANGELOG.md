# Changelog

## v18 — 2026-09-09 (Phase 7: durability + speed fix)
- Test suite (`node tests/run.mjs`, zero dependencies, 57 checks): response shape, honesty (no number absent from resume/profile/posting), ban list, knockout + DNV presence, marker-format assembly fallbacks, feed filter rules with mocked sources, page budget, 360px layout guards.
- GitHub Action runs the tests on every push and **blocks the Pages deploy on failure**; nightly health check probes `/api/health` + `/api/jobs` (feed size, junk rate >20%, stale KV, dead cron) and opens a GitHub issue on failure (Telegram intentionally skipped).
- Speed fix for tailoring: the anti-slop pass no longer blocks — results render the moment the stream ends, and any polish/warning arrives in the background; output caps tightened (~30% fewer output tokens).
- Feed title filter fixed: "service" no longer matches "Microservices" (caught by the new tests).
- Version string in the footer; wrangler pinned exactly.

## v17 — 2026-09-09 (Phase 6: speed + reliability)
- Page 96 KB raw / ~28 KB gzipped; reduce-motion honored; plain-language streaming progress; job-box draft autosave; fetch retries with backoff; private-mode detection; stale feed shown instead of hanging.
- Worker: 8s upstream timeouts, 300 KB body cap (413), ETag + Cache-Control on `/api/jobs` (304 revalidation), KV error ring buffer at `/api/errors`.

## v16 — 2026-09-09 (Phase 5: stats)
- Stats card from her own records vs verified benchmarks (Huntr 4.23%/2.07%, SHRM 42-day fill, 108-day median search); reply-rate breakdowns; pace guard over 20 apps/week; weekly "change one thing" box.

## v15 — 2026-09-09 (Phase 4: tracking)
- Application records with statuses; due engine (outreach day 3, follow-ups day 7/14, auto "no response"); pre-written outreach/follow-up emails; calendar + notification reminders; proof-to-Parker email; KV sync + Parker's verification page (`/api/apps?view=html`); visa 3-month clock with document checklist; CSV export.

## v14 — 2026-09-09 (Phase 3: jobs feed)
- 36 verified company boards in `worker/companies.json` + aggregators; hard title/region/freshness/dedupe filters; Kosovo-OK signal; KV feed refreshed by a 3-hour cron; top-5-per-day pacing; ⚡ apply-now + visa salary chips; Google Jobs link.

## v13 — 2026-09-09 (Phase 2c: profile)
- One Profile screen (country, targets, thresholds, languages CEFR, stored answers, title synonyms, output language); up to 5 named base resumes with fit suggestions; nothing situation-specific hard-coded server-side.

## v12 — 2026-09-09 (Phase 2b: anti-slop)
- `worker/banned.json` ban list + mechanical scanner (phrases, "As a…", em-dash chains, three-adjective lists, untraceable numbers); Haiku slop grade with one regenerate; voice sample; word-level diff with per-line vetoes.

## v11 — 2026-09-09 (Phases 1–2: audit + honest tailoring)
- README evidence list rebuilt from sources verified 2026-09-09 (dead links replaced with primaries, unsupported claims flagged).
- New tailoring prompt: knockout pre-check, fit rule, mandatory Languages (CEFR) + Tools sections, claims-traced honesty self-check, gaps with verified free courses, location/visa paste-ready answers + EOR wording, DNV salary fit, 5 drafted screening answers, scam score, why-this-score.

## v10 and earlier — 2026-09-07/08
- Initial tool: paste resume + job link → tailored resume with match score, ATS check, cover letter, apply kit, basic follow-up tracker. GitHub Pages + Cloudflare Worker, key secret-only.
