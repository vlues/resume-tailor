#!/usr/bin/env node
// Resume Tailor test suite — zero dependencies. Run: node tests/run.mjs
// Checks response shape, honesty, ban list, knockout/DNV presence, feed
// filter rules and fallbacks, page weight, and basic 360px layout guards.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}

// ---- load the worker's pure functions (strip JSON imports node can't take)
const src = read('worker/src/index.js')
  .replace(/^import BANNED.*$/m, `const BANNED = ${read('worker/banned.json')};`)
  .replace(/^import COMPANIES.*$/m, `const COMPANIES = ${read('worker/companies.json')};`)
  .replace(/^export default/m, 'const __handler =')
  + '\nexport { slopScan, slopFields, filterFeed, assembleTailorResult, parseClaudeJson, normCo, trimRaw, __handler };\n';
const tmp = path.join(root, 'tests', '.worker-under-test.mjs');
fs.writeFileSync(tmp, src);
const W = await import(pathToFileURL(tmp).href);
fs.unlinkSync(tmp);

const resume = read('tests/fixtures/resume.txt');
const profile = read('tests/fixtures/profile.txt');
const job = read('tests/fixtures/job-support.txt');
const R = JSON.parse(read('tests/fixtures/tailor-response.json'));

console.log('\n1. Response shape');
for (const k of ['tailored_resume','match_before','match_after','knockout','fit','changes','keywords_added','missing_keywords','gaps','claims_traced','questions_for_her','ats_check','cover_note','cover_letter','follow_up','screening_questions','scam_risk','location_fit','location_visa','dnv_fit','why_score','tips','apply_kit','candidate_name','job_title','company'])
  check('has ' + k, k in R);
check('knockout pre-check present with verdicts', Array.isArray(R.knockout) && R.knockout.every(x => ['PASS','FAIL','ASK'].includes(x.verdict)));
check('fit has met_pct + proceed + reason', typeof R.fit.met_pct === 'number' && typeof R.fit.proceed === 'boolean' && R.fit.reason.length > 5);
check('dnv_fit computed', ['MEETS','BELOW','UNKNOWN'].includes(R.dnv_fit.status) && typeof R.dnv_fit.note === 'string');
check('apply_kit has the 5 required answers', (R.apply_kit.answers || []).length === 5);
check('exactly 5 screening questions with draft answers', R.screening_questions.length === 5 && R.screening_questions.every(x => x.q && x.answer));
check('scam score 0-10', R.scam_risk.score >= 0 && R.scam_risk.score <= 10);
check('claims_traced covers the key numbers', R.claims_traced.length >= 4 && R.claims_traced.every(c => c.claim && c.source));

console.log('\n2. Honesty — every number in the output exists in her materials or the posting');
const fields = W.slopFields(R);
const flags = W.slopScan(fields, job, resume + '\n' + profile);
const numberFlags = flags.filter(f => f.reason.includes('number'));
check('no untraceable numbers', numberFlags.length === 0, JSON.stringify(numberFlags));
console.log('\n3. Ban list + slop rules');
const banFlags = flags.filter(f => !f.reason.includes('number'));
check('no banned phrases / AI-tells / template closings', banFlags.length === 0, JSON.stringify(banFlags.slice(0, 3)));
check('mechanical slop flags = 0 (proxy for slop score under threshold)', flags.length === 0);
// and the scanner itself still catches sins:
const sins = W.slopScan({ x: 'As a passionate professional, I leverage synergy — daily — with a proven track record of 9999 wins. I look forward to the opportunity to contribute.' }, '', '');
check('scanner still catches banned phrases', sins.some(f => f.reason.includes('passionate')) && sins.some(f => f.reason.includes('leverage')));
check('scanner still catches invented numbers', sins.some(f => f.reason.includes('9999')));
check('scanner still catches "As a…" and em-dash chains', sins.some(f => f.reason.includes('As a')) && sins.some(f => f.reason.includes('em-dash')));

console.log('\n4. Marker-format assembly + fallbacks');
const assembled = W.assembleTailorResult('===RESUME===\nTHE RESUME\n===DATA===\n{"match_after": 80}');
check('assembles resume + data', assembled && assembled.tailored_resume === 'THE RESUME' && assembled.match_after === 80);
const fenced = W.assembleTailorResult('===RESUME===\nR\n===DATA===\n```json\n{"match_after": 70}\n```');
check('tolerates markdown fences', fenced && fenced.match_after === 70);
check('plain-JSON fallback works', W.parseClaudeJson('noise {"a":1} trailing')?.a === 1);

console.log('\n5. Feed filter rules (sources mocked)');
const now = Date.now();
const mk = (o) => ({ title: 'Customer Support Specialist', company: 'Co', url: 'https://x/' + Math.random(), location: 'Anywhere', ts: now - 86400000, date: '', salary: '', source: 'T', ...o });
const feed = W.filterFeed([
  mk({}),                                                    // good
  mk({ title: 'Microservices Engineer' }),                   // wrong title
  mk({ location: 'Remote - Colombia' }),                     // wrong region
  mk({ title: 'Support Manager, East' }),                    // US region in title
  mk({ location: 'Boston, on-site' }),                       // in-office
  mk({ ts: now - 9 * 86400000 }),                            // stale
  mk({ ts: 0 }),                                             // unknown date
  mk({ company: 'Remote.com', title: 'Support Hero' }),      // dupe pair ↓
  mk({ company: 'Remote', title: 'Support Hero' }),
], '', 7);
check('keeps the good job', feed.some(j => j.title === 'Customer Support Specialist'));
check('drops wrong title', !feed.some(j => j.title.includes('Microservices')));
check('drops wrong-region remote', !feed.some(j => (j.location || '').includes('Colombia')));
check('drops US-region title', !feed.some(j => j.title.includes('East')));
check('drops in-office', !feed.some(j => (j.location || '').includes('Boston')));
check('drops stale + unknown-date', feed.every(j => now - j.ts <= 7 * 86400000 && j.ts > 0));
check('dedupes Remote vs Remote.com', feed.filter(j => j.title === 'Support Hero').length === 1);
check('empty sources → empty feed (fallback path reachable)', W.filterFeed([], '', 7).length === 0);
check('kosovoOk flags anywhere/worldwide', feed.find(j => j.title === 'Customer Support Specialist').kosovoOk === true);

console.log('\n6. Page budget + layout guards (360px)');
const html = read('index.html');
check('page under 100 KB raw', Buffer.byteLength(html) < 100000, Buffer.byteLength(html) + ' bytes');
check('viewport meta present', html.includes('width=device-width'));
check('no fixed CSS widths over 360px', !/[^-]width\s*:\s*(3[7-9]\d|[4-9]\d\d|\d{4,})px/.test(html), (html.match(/[^-]width\s*:\s*\d{3,}px/g) || []).join(','));
check('reduce-motion honored', html.includes('prefers-reduced-motion'));
const inline = /<script>([\s\S]*)<\/script>/.exec(html)[1];
fs.writeFileSync(path.join(root, 'tests', '.inline.js'), inline);
try { execFileSync('node', ['--check', path.join(root, 'tests', '.inline.js')]); check('inline JS parses', true); }
catch (e) { check('inline JS parses', false, String(e).slice(0, 100)); }
fs.unlinkSync(path.join(root, 'tests', '.inline.js'));
check('worker JS parses', (() => { try { execFileSync('node', ['--check', path.join(root, 'worker/src/index.js')]); return true; } catch { return false; } })());

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
