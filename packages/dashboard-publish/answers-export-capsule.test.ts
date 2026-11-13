import {test, expect} from 'bun:test';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
// @ts-ignore standalone publisher command
import {main, snapshot} from './answers-export.mjs';
const sentinel = 'SYNTHETIC_TOKEN_SENTINEL';
// Hosted macOS runners are several times slower than a laptop: each test that spawns node or awaits the exporter
// declares its budget, and the child gets a shorter one so a hang ends as a readable ETIMEDOUT, not a dangling process.
const TEST_BUDGET_MS = 60_000, CHILD_BUDGET_MS = 45_000;
const html = '<article data-decision="choice" data-title="Synthetic choice"><label><input type="radio" name="choice" value="Alpha">Alpha label</label></article>';
function fixture(overrides: Record<string, unknown> = {}) {
 const dir = fs.mkdtempSync(join(tmpdir(), 'nl-fake-capsule-'));
 const artifact = {shells:{'synthetic.html':html}};
 const hash = 'sha256:' + createHash('sha256').update(JSON.stringify(artifact)).digest('hex');
 const state = {hash, rows:[{ownerId:'synthetic-owner',dashboardId:'synthetic',key:'choice',value:'"Alpha"',revision:1},{ownerId:'synthetic-owner',dashboardId:'other',key:'choice',value:'"OTHER_PAGE_SECRET"',revision:1}], ...overrides};
 const put = (name: string, content: string) => {const file=join(dir,name);fs.mkdirSync(join(file,'..'),{recursive:true});fs.writeFileSync(file,content);};
 put('state.json',JSON.stringify(state));
 // The fake modules carry their own state path instead of reading a shared process.env, so a timed-out test that
 // finishes late cannot change what the next test's in-process import sees.
 const statePath=join(dir,'state.json');
 const load = `import fs from 'node:fs'; const statePath=${JSON.stringify(statePath)}; const state=()=>JSON.parse(fs.readFileSync(statePath,'utf8'));`;
 put('scripts/publish-runtime.mjs',load+`if(state().vendor)throw Error('${sentinel} vendor');export const api='synthetic-api',deployId='synthetic-deploy';`);
 put('node_modules/lakebed/package.json','{"type":"module"}');
 put('node_modules/lakebed/dist/cli/developer-auth.js',load+`export async function developerTokenForApi(){return state().noToken?null:'${sentinel}';}`);
 put('node_modules/lakebed/dist/cli/inspect.js',load+`export async function hostedJsonClient(){let n=0;return async route=>{fs.appendFileSync(statePath+'.reads',route+'\\n');const s=state();if(s.sdk)throw Error('PUBLISH_LOCK ${sentinel} sdk');if(route.includes('/db?'))return {truncated:s.truncated,tables:{answers:s.rows}};return {artifactHash:++n>1&&s.drift?'other':s.hash};};}`);
 put('node_modules/lakebed/dist/_core/index.js','export const stableStringify=JSON.stringify;');
 put('scripts/publish_readback.py','import json,sys\nprint(json.dumps(json.loads(sys.stdin.readline())["artifact"]["shells"]))\n');
 put('.lakebed/synthetic-artifact.json',JSON.stringify({artifactHash:hash,artifact:overrides.tampered?{shells:{}}:artifact}));
 const out=join(dir,'report.md'), runtime=join(dir,'scripts/publish-runtime.mjs');
 const args=['export','--dashboard','synthetic','--out',out,'--runtime',runtime];
 const cli=(extra: string[]=[])=>{const result=spawnSync('node',[resolve('packages/dashboard-publish/answers-export.mjs'),...args,...extra],{encoding:'utf8',timeout:CHILD_BUDGET_MS});if(result.error)throw result.error;return result;};
 return {dir,out,runtime,args,statePath,cli,put,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('fake capsule main writes only requested rows, private atomic replacement, no sentinel', async () => {
 const f=fixture();const oldMask=process.umask(0o022);
 try {
  fs.writeFileSync(f.out,'old',{mode:0o644});fs.chmodSync(f.out,0o644);
  await main([...f.args]);
  const content=fs.readFileSync(f.out,'utf8');
  expect(content).toContain('Alpha');expect(content).not.toContain('OTHER_PAGE_SECRET');expect(content).not.toContain(sentinel);
  expect(fs.statSync(f.out).mode & 0o777).toBe(0o600);
  const result=f.cli();expect(result.status).toBe(0);expect(result.stdout+result.stderr+fs.readFileSync(f.out,'utf8')).not.toContain(sentinel);
 } finally {process.umask(oldMask);f.cleanup();}
}, TEST_BUDGET_MS);
for (const [name,state,code] of [
 ['drift',{drift:true},'MANIFEST_DRIFT'],['tampered artifact',{tampered:true},'ARTIFACT_BINDING'],['truncated',{truncated:true},'HOSTED_READ_TRUNCATED'],['no login',{noToken:true},'DEVELOPER_AUTH_REQUIRED'],['vendor mismatch',{vendor:true},'VENDOR_MISMATCH'],['SDK sentinel',{sdk:true},'HOSTED_READ_FAILED']
] as const) test('fake capsule refuses '+name+' without report or token disclosure', async () => {
 const f=fixture(state);
 try {
  try {await snapshot(f.runtime);throw Error('expected refusal');} catch(error) {expect(String(error)).toContain(code);expect(String(error)).not.toContain(sentinel);}
  const result=f.cli();expect(result.status).toBe(1);expect(result.stderr).toContain(code);expect(result.stdout+result.stderr).not.toContain(sentinel);expect(fs.existsSync(f.out)).toBe(false);
 } finally {f.cleanup();}
}, TEST_BUDGET_MS);
for (const name of ['lock','missing artifact','missing runtime','duplicate dashboard','missing output directory','output symlink','parent symlink','unwritable parent','missing shell','jobs title mismatch']) test('fake capsule refuses '+name, () => {
 const f=fixture();
 try {
  if(name==='lock')f.put('DEPLOY.lock','synthetic');
  if(name==='missing artifact')fs.rmSync(join(f.dir,'.lakebed/synthetic-artifact.json'));
  if(name==='missing runtime')fs.rmSync(f.runtime);
  if(name==='duplicate dashboard')f.args.push('--dashboard','synthetic');
  if(name==='missing output directory')f.args[f.args.indexOf('--out')+1]=join(f.dir,'missing','report.md');
  if(name==='output symlink'){f.put('untouched','old');fs.symlinkSync(join(f.dir,'untouched'),f.out);}
  if(name==='parent symlink'){fs.symlinkSync(f.dir,join(f.dir,'alias'));f.args[f.args.indexOf('--out')+1]=join(f.dir,'alias','report.md');}
  if(name==='unwritable parent'){fs.mkdirSync(join(f.dir,'readonly'),{mode:0o500});f.args[f.args.indexOf('--out')+1]=join(f.dir,'readonly','report.md');}
  if(name==='missing shell')f.args[f.args.indexOf('--dashboard')+1]='absent';
  if(name==='jobs title mismatch'){f.put('jobs/synthetic/job.json',JSON.stringify({decisions:[{id:'choice',title:'Different',options:['Alpha']}]}));f.args.push('--jobs-dir',join(f.dir,'jobs'));}
  const result=f.cli();expect(result.status).toBe(1);expect(result.stdout+result.stderr).not.toContain(sentinel);
  const codes: Record<string,string>={'lock':'PUBLISH_LOCK','missing artifact':'RETAINED_ARTIFACT_MISSING','missing runtime':'RUNTIME_MISSING','missing shell':'DASHBOARD_SHELL_MISSING'};
  if(codes[name])expect(result.stderr).toContain(codes[name]);
  if(name==='output symlink')expect(fs.readFileSync(join(f.dir,'untouched'),'utf8')).toBe('old');else expect(fs.existsSync(f.out)).toBe(false);
  if(['output symlink','parent symlink','missing output directory','unwritable parent'].includes(name))expect(fs.existsSync(f.statePath+'.reads')).toBe(false);
 } finally {if(fs.existsSync(join(f.dir,'readonly')))fs.chmodSync(join(f.dir,'readonly'),0o700); f.cleanup();}
}, TEST_BUDGET_MS);

test('CLI never relays malformed answer JSON in error messages', () => {
 const f=fixture({rows:[{ownerId:'synthetic-owner',dashboardId:'synthetic',key:'choice',value:'{'+sentinel,revision:1}]});
 try {const result=f.cli();expect(result.status).toBe(1);expect(result.stderr).toContain('EXPORT_FAILED');expect(result.stdout+result.stderr).not.toContain(sentinel);expect(fs.existsSync(f.out)).toBe(false);} finally {f.cleanup();}
}, TEST_BUDGET_MS);
