#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path';
import {pathToFileURL} from 'node:url'; import {execFileSync} from 'node:child_process';
import {Window} from 'happy-dom';
import {createHash, randomBytes} from 'node:crypto';
export function assertUnlocked(capsule) { if (fs.existsSync(path.join(capsule, 'DEPLOY.lock'))) refuse('PUBLISH_LOCK'); }
export function assertComplete(db) { if (db.truncated || !db.tables || Object.values(db.tables).some(rows => !Array.isArray(rows) || rows.length >= 1000)) refuse('HOSTED_READ_TRUNCATED'); }
class ExportError extends Error {}
const refuse = code => { throw new ExportError(code); };
export async function snapshot(runtimePath, baselineDirs = []) {
  const capsule = path.resolve(path.dirname(runtimePath), '..');
  assertUnlocked(capsule);
  if (!fs.existsSync(runtimePath)) refuse('RUNTIME_MISSING');
  let runtime;
  try { runtime = await import(pathToFileURL(path.resolve(runtimePath)).href); }
  catch { refuse('VENDOR_MISMATCH'); }
  try {
    const auth = await import(pathToFileURL(path.join(capsule, 'node_modules/lakebed/dist/cli/developer-auth.js')).href);
    const inspect = await import(pathToFileURL(path.join(capsule, 'node_modules/lakebed/dist/cli/inspect.js')).href);
    let token;
    try { token = await auth.developerTokenForApi(runtime.api); } catch { refuse('DEVELOPER_AUTH_REQUIRED'); }
    if (!token) refuse('DEVELOPER_AUTH_REQUIRED');
    const read = await inspect.hostedJsonClient(runtime.deployId, ['--inspect-token', token], AbortSignal.timeout(45000), 16 * 1024 * 1024, capsule);
    assertUnlocked(capsule);
    const before = await read('/__lakebed/manifest'); const db = await read('/__lakebed/db?limit=1000');
    const at = new Date().toISOString(); assertComplete(db);
    const after = await read('/__lakebed/manifest');
    if (before.artifactHash !== after.artifactHash) refuse('MANIFEST_DRIFT');
    let envelope;
    for (const dir of [path.join(capsule, '.lakebed'), ...baselineDirs]) {
      for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!name.endsWith('artifact.json')) continue;
        const candidate = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (candidate.artifactHash === before.artifactHash) envelope = candidate;
      }
    }
    if (!envelope) refuse('RETAINED_ARTIFACT_MISSING');
    const {stableStringify} = await import(pathToFileURL(path.join(capsule, 'node_modules/lakebed/dist/_core/index.js')).href);
    if ('sha256:' + createHash('sha256').update(stableStringify(envelope.artifact)).digest('hex') !== before.artifactHash) refuse('ARTIFACT_BINDING');
    const shells = JSON.parse(execFileSync('python3', ['-B', path.join(capsule, 'scripts/publish_readback.py')], {input: JSON.stringify(envelope) + '\n', maxBuffer: 32 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']}));
    return {at, artifactHash: before.artifactHash, rows: db.tables.answers ?? [], shells};
  } catch (error) {
    // Only exporter-owned errors are safe; vendor text can contain credentials.
    if (error instanceof ExportError) throw error;
    refuse('HOSTED_READ_FAILED');
  }
}
const hasContent = value => value && typeof value === 'object' ? Object.values(value).some(hasContent) : value !== null && value !== '' && value !== false && value !== undefined;
const clean = value => String(value).replace(/\s+/g, ' ').trim();
const md = value => clean(value).replace(/[\\`*_{}\[\]()#+.!|<>~-]/g, '\\$&');
const ownerHash = row => createHash('sha256').update(String(row.ownerId ?? 'unknown')).digest('hex').slice(0, 12);
const bookkeeping = key => key.startsWith('__') || key.startsWith('_notes:');
const literal = value => {
  const json = JSON.stringify(value);
  const fence = '`'.repeat(Math.max(3, ...[...json.matchAll(/`+/g)].map(match => match[0].length + 1)));
  return '\n\n' + fence + 'json\n' + json + '\n' + fence;
};
export function report(snapshot, ids, jobs = {}) {
  const counts = {}; let unmatched = 0;
  const sections = [];
  for (const id of ids) {
    if (!Object.hasOwn(snapshot.shells, id + '.html')) refuse('DASHBOARD_SHELL_MISSING');
    const win = new Window({settings: {disableJavaScriptFileLoading: true, disableCSSFileLoading: true, navigation: {disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true}}});
    const settings = win.happyDOM.settings;
    if (settings.enableJavaScriptEvaluation || !settings.navigation.disableMainFrameNavigation || !settings.navigation.disableChildFrameNavigation || !settings.navigation.disableChildPageNavigation) refuse('UNSAFE_HTML_SETTINGS');
    const doc = win.document;
    doc.body.innerHTML = snapshot.shells[id + '.html'];
    const cards = [...doc.querySelectorAll('[data-decision]')];
    if (!cards.length) refuse('DASHBOARD_CARDS_MISSING');
    const rows = snapshot.rows.filter(row => row.dashboardId === id);
    const owners = [...new Set(rows.map(ownerHash))]; const used = new Set(); let optionPicked = 0, decisions = 0, notesCards = 0, noteOnlyDecisions = 0; const lines = [`## ${md(id)}`, owners.length === 1 ? `One owner: ${owners[0]}.` : `${owners.length} owners; grouped by owner hash.`];
    for (const [index, card] of cards.entries()) {
      const key = card.getAttribute('data-decision');
      const radios = [...card.querySelectorAll('input[type="radio"]')];
      const checks = [...card.querySelectorAll('input[type="checkbox"]')];
      const isDecision = radios.length > 0 || checks.length > 0;
      if (isDecision) decisions++;
      const title = card.getAttribute('data-title') ?? card.querySelector('h2,h3')?.textContent ?? key;
      const job = jobs[id]?.decisions?.find(item => item.id === key);
      if (jobs[id] && (!job || job.title !== title)) throw Error('Build input and hosted title differ.');
      lines.push(`### ${index + 1}. ${md(title)} (${isDecision ? 'decision' : 'note card'})`);
      if (isDecision) lines.push('Options (hosted labels and saved values):');
      for (const input of [...radios, ...checks]) {
        lines.push(`- ${md(input.closest('label')?.textContent ?? input.value)} [${md(input.type === 'checkbox' ? input.dataset.checkIndex ?? input.value : input.value)}]`);
      }
      if (job && job.options !== undefined) lines.push('Build input options:' + literal(job.options));
      let picked = false, hasNote = false, hasSaved = false;
      const keys = new Set([key, ...radios.map(input => input.name), key + '-free', key + '-checks', key + '-notes']);
      for (const owner of owners) {
      const group = rows.filter(row => ownerHash(row) === owner && keys.has(row.key) && !bookkeeping(row.key));
      if (group.length && owners.length > 1) lines.push(`Owner ${owner}:`);
      for (const row of group) {
        used.add(row);
        const value = JSON.parse(row.value);
        const empty = !hasContent(value);
        const note = !isDecision || row.key === key + '-free' || row.key === key + '-notes';
        const selectedChecks = row.key === key + '-checks' && Array.isArray(value) ? checks.filter(input => value.map(String).includes(input.dataset.checkIndex ?? input.value)) : [];
        const selected = !note && !empty && (radios.some(input => input.name === row.key && input.value === value) || selectedChecks.length > 0);
        if (!empty) hasSaved = true;
        if (!empty && note) hasNote = true;
        if (selected) picked = true;
        const label = empty ? "empty (the publisher's probe uses this key)" : note ? "Owner's text (verbatim JSON)" : selected ? 'Picked' : 'Saved value not among the options';
        lines.push(`${label}; key ${md(row.key)}; revision ${md(row.revision)}; ${row.updatedAt ? 'row updated ' + md(row.updatedAt) : 'time not recorded'}:` + literal(value));
        if (selectedChecks.length) lines.push('Picked options: ' + selectedChecks.map(input => md(input.closest('label')?.textContent ?? input.value)).join(', '));
      }
      }
      if (hasNote) notesCards++;
      if (picked) optionPicked++;
      if (isDecision && hasNote && !picked) noteOnlyDecisions++;
      lines.push(isDecision ? picked ? 'Option picked.' : hasNote ? 'Note only; no option picked.' : hasSaved ? 'Saved value not among the options.' : 'Unanswered; no option picked.' : hasNote ? 'Note recorded.' : 'No note recorded.');
    }
    lines.push('### Unmatched keys');
    for (const row of rows.filter(row => !used.has(row) && !bookkeeping(row.key))) {
      const value = JSON.parse(row.value);
      unmatched++;
      lines.push(`Unmatched; owner ${ownerHash(row)}; key ${md(row.key)}; revision ${md(row.revision)}; ${md(row.updatedAt ?? 'time not recorded')}:` + literal(value));
    }
    lines.push('### App bookkeeping');
    for (const row of rows.filter(row => bookkeeping(row.key))) lines.push(`- key ${md(row.key)}; revision ${md(row.revision)}`);
    counts[id] = {optionPicked, decisions, notesCards, noteOnlyDecisions}; sections.push(lines.join('\n\n'));
    win.close();
  }
  return {markdown: `Read ${md(snapshot.at)}; hosted artifact ${md(snapshot.artifactHash)}; ${Object.entries(counts).map(([id,c]) => `${md(id)}: ${c.optionPicked}/${c.decisions} decisions with an option picked; free-text notes on ${c.notesCards} cards; ${c.noteOnlyDecisions} decision cards with note only`).join('; ')}; read-only: no row, page or setting was changed.\n\nValues are JSON encoded to preserve verbatim strings, including newlines. Row update times describe the whole saved value, not individual selections.\n\n` + sections.join('\n\n'), counts, unmatched};
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
  if (!runtime) refuse('RUNTIME_MISSING');
  if (!ids.length || !out || !runtime || new Set(ids).size !== ids.length || ids.some(id => !/^[a-zA-Z0-9_-]+$/.test(id))) throw Error('Unique dashboard ids, output and local runtime are required.');
  validateOutput(out);
  const jobs = jobsDir ? Object.fromEntries(ids.map(id => [id, JSON.parse(fs.readFileSync(path.join(jobsDir, id, 'job.json'), 'utf8'))])) : {};
  const result = report(await snapshot(runtime, dirs), ids, jobs);
  writeReport(out, result.markdown);
  return result;
}
export function validateOutput(out) {
  try {
    const parent = path.dirname(path.resolve(out));
    if (fs.lstatSync(parent).isSymbolicLink() || !fs.statSync(parent).isDirectory() || !(fs.statSync(parent).mode & 0o222)) refuse('OUTPUT_INVALID');
    fs.accessSync(parent, fs.constants.W_OK);
    if (fs.existsSync(out) || fs.lstatSync(out, {throwIfNoEntry: false})) {
      if (fs.lstatSync(out).isSymbolicLink() || !fs.statSync(out).isFile()) refuse('OUTPUT_INVALID');
    }
  } catch { refuse('OUTPUT_INVALID'); }
}
export function writeReport(out, markdown) {
  validateOutput(out);
  const temp = path.join(path.dirname(path.resolve(out)), '.answers-' + randomBytes(12).toString('hex'));
  try {
    fs.writeFileSync(temp, markdown, {mode: 0o600, flag: 'wx'});
    fs.renameSync(temp, out);
  } finally { fs.rmSync(temp, {force: true}); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof ExportError ? error.message : 'EXPORT_FAILED');
    process.exitCode = 1;
  });
}
