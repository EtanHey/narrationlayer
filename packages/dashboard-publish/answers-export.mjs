#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
import {pathToFileURL} from 'node:url'; import {execFileSync} from 'node:child_process';
import {Window} from 'happy-dom';
export function assertUnlocked(capsule) { if (fs.existsSync(path.join(capsule, 'DEPLOY.lock'))) throw Error('Publish lock present; export refused.'); }
export function assertComplete(db) { if (db.truncated || !db.tables || Object.values(db.tables).some(rows => !Array.isArray(rows) || rows.length >= 1000)) throw Error('Hosted read truncated or invalid; export refused.'); }
export async function snapshot(runtimePath, baselineDirs = []) {
  const capsule = path.resolve(path.dirname(runtimePath), '..');
  assertUnlocked(capsule);
  try {
    const runtime = await import(pathToFileURL(path.resolve(runtimePath)).href);
    const auth = await import(pathToFileURL(path.join(capsule, 'node_modules/lakebed/dist/cli/developer-auth.js')).href);
    const inspect = await import(pathToFileURL(path.join(capsule, 'node_modules/lakebed/dist/cli/inspect.js')).href);
    const token = await auth.developerTokenForApi(runtime.api); if (!token) throw Error('auth');
    const read = await inspect.hostedJsonClient(runtime.deployId, ['--inspect-token', token], AbortSignal.timeout(45000), 16 * 1024 * 1024, capsule);
    assertUnlocked(capsule);
    const before = await read('/__lakebed/manifest'); const db = await read('/__lakebed/db?limit=1000');
    const at = new Date().toISOString(); assertComplete(db);
    const after = await read('/__lakebed/manifest');
    if (before.artifactHash !== after.artifactHash) throw Error('drift');
    let envelope;
    for (const dir of [path.join(capsule, '.lakebed'), ...baselineDirs]) {
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!name.endsWith('artifact.json')) continue;
        const candidate = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (candidate.artifactHash === before.artifactHash) envelope = candidate;
      }
    }
    if (!envelope) throw Error('baseline');
    const {stableStringify} = await import(pathToFileURL(path.join(capsule, 'node_modules/lakebed/dist/_core/index.js')).href);
    const {createHash} = await import('node:crypto');
    if ('sha256:' + createHash('sha256').update(stableStringify(envelope.artifact)).digest('hex') !== before.artifactHash) throw Error('baseline');
    const shells = JSON.parse(execFileSync('python3', ['-B', path.join(capsule, 'scripts/publish_readback.py')], {input: JSON.stringify(envelope) + '\n', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']}));
    return {at, artifactHash: before.artifactHash, rows: db.tables.answers ?? [], shells};
  } catch (error) {
    // SDK errors can contain request details: never relay their text.
    if (/^(Publish lock|Hosted read)/.test(error.message)) throw error;
    throw Error('Authenticated export failed: check developer login, retained artifact and publisher readback tooling. No report written.');
  }
}
const literal = value => '\n' + JSON.stringify(value) + '\n';
export function report(snapshot, ids, jobs = {}) {
  const counts = {}; let unmatched = 0;
  const sections = [];
  for (const id of ids) {
    if (!Object.hasOwn(snapshot.shells, id + '.html')) throw Error('Requested dashboard shell missing.');
    const win = new Window({settings: {disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true, disableIframePageLoading: true}});
    const doc = win.document;
    doc.body.innerHTML = snapshot.shells[id + '.html'];
    const cards = [...doc.querySelectorAll('[data-decision]')];
    if (!cards.length) throw Error('Unsupported dashboard: no decision cards.');
    const rows = snapshot.rows.filter(row => row.dashboardId === id); const used = new Set(); let answered = 0, decisions = 0; const lines = [`## ${id}`];
    for (const card of cards) {
      const key = card.getAttribute('data-decision');
      const radios = [...card.querySelectorAll('input[type="radio"]')];
      const checks = [...card.querySelectorAll('input[type="checkbox"]')];
      if (!radios.length && !checks.length) continue;
      decisions++; const title = card.getAttribute('data-title') ?? card.querySelector('h2,h3')?.textContent ?? key;
      const job = jobs[id]?.decisions?.find(item => item.id === key);
      if (jobs[id] && (!job || job.title !== title)) throw Error('Build input and hosted title differ.');
      lines.push(`### ${decisions}. ${title}`);
      lines.push('Options (hosted labels and saved values):');
      for (const input of [...radios, ...checks]) {
        lines.push(`- ${input.closest('label')?.textContent.trim() ?? input.value} [${input.value}]`);
      }
      if (job) lines.push('Build input options: ' + JSON.stringify(job.options));
      let hasAnswer = false;
      const keys = new Set([key, ...radios.map(input => input.name), key + '-free', key + '-checks', key + '-notes']);
      for (const row of rows.filter(row => keys.has(row.key))) {
        used.add(row);
        const value = JSON.parse(row.value);
        const empty = value === null || value === '' || (Array.isArray(value) && !value.length);
        if (!empty) hasAnswer = true;
        lines.push(`${empty ? 'Empty/probe marker' : row.key.endsWith('-free') ? 'Free text (verbatim JSON string)' : 'Picked / saved value (verbatim JSON)'}; key ${row.key}; revision ${row.revision}; ${row.updatedAt ? 'row updated ' + row.updatedAt : 'time not recorded'}:` + literal(value));
      }
      if (hasAnswer) answered++; else lines.push('Unanswered.');
    }
    lines.push('### Unmatched / publisher probe markers');
    for (const row of rows.filter(row => !used.has(row))) {
      const value = JSON.parse(row.value);
      const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
      if (!empty) unmatched++;
      lines.push(`${empty ? 'Empty/probe marker' : 'Unmatched'}; key ${row.key}; revision ${row.revision}; ${row.updatedAt ?? 'time not recorded'}:` + literal(value));
    }
    counts[id] = {answered, decisions}; sections.push(lines.join('\n\n'));
    win.close();
  }
  return {markdown: `Read ${snapshot.at}; hosted artifact ${snapshot.artifactHash}; ${Object.entries(counts).map(([id,c]) => `${id}: ${c.answered}/${c.decisions} decisions answered`).join('; ')}; read-only: no row, page or setting was changed.\n\nValues are JSON encoded to preserve verbatim strings, including newlines. Row update times describe the whole saved value, not individual selections.\n\n` + sections.join('\n\n'), counts, unmatched};
}
export async function main(args) {
  if (args.shift() !== 'export') throw Error('Usage: answers-export.mjs export --dashboard <id> --out <file.md> --runtime <local publish-runtime.mjs> [--baseline-dir <dir>] [--jobs-dir <dir>]');
  const ids = [], dirs = []; let out, runtime = process.env.NARRATIONLAYER_PUBLISH_RUNTIME, jobsDir;
  while (args.length) {
    const flag = args.shift(), value = args.shift();
    if (!value || value.startsWith('--')) throw Error('Missing option value.');
    if (flag === '--dashboard') ids.push(value); else if (flag === '--out') out = value;
    else if (flag === '--runtime') runtime = value;
    else if (flag === '--baseline-dir') dirs.push(value);
    else if (flag === '--jobs-dir') jobsDir = value;
    else throw Error('Unknown option.');
  }
  if (!ids.length || !out || !runtime || new Set(ids).size !== ids.length || ids.some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) throw Error('Unique dashboard ids, output and local runtime are required.');
  const jobs = jobsDir ? Object.fromEntries(ids.map(id => [id, JSON.parse(fs.readFileSync(path.join(jobsDir, id, 'job.json'), 'utf8'))])) : {};
  const result = report(await snapshot(runtime, dirs), ids, jobs);
  fs.writeFileSync(out, result.markdown, {mode: 0o600});
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const safe = /^(Publish lock present|Hosted read truncated|Authenticated export failed|Usage:|Missing option|Unknown option|Unique dashboard|Requested dashboard|Unsupported dashboard|Build input)/.test(error.message);
    console.error(safe ? error.message : 'Answers export refused: invalid local configuration or output path.');
    process.exitCode = 1;
  });
}
