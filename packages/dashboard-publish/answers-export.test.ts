import {test, expect} from 'bun:test';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
// @ts-ignore standalone publisher command
import {report, assertComplete, assertUnlocked} from './answers-export.mjs';
const page = `<article data-decision="choice" data-title="Synthetic choice"><label><input type="radio" name="choice" value="Alpha">Alpha label</label><label><input type="radio" name="choice" value="Beta">Beta label</label></article><article data-decision="later" data-title="Synthetic later"><input type="radio" name="later" value="Next"></article>`;
const row = (key: string, value: unknown) => ({dashboardId:'synthetic', key, value:JSON.stringify(value), revision:3, updatedAt:'2001-01-01T00:00:00Z'});
test('matches fields, preserves text, lists unanswered, probes and unmatched', () => {
 const result = report({at:'2001-01-02T00:00:00Z',artifactHash:'synthetic-hash',shells:{'synthetic.html':page},rows:[row('choice','Beta'),row('choice-free','line one\nline two'),row('probe',null),row('unknown','Extra')]}, ['synthetic']);
 expect(result.counts.synthetic).toEqual({optionPicked:1,decisions:2,notesCards:1,noteOnlyDecisions:0});
 for (const text of ['Synthetic choice','Alpha label','Beta label','"Beta"','line one\\nline two','Unanswered; no option picked.','key `probe`','key `unknown`','revision `3`','`2001-01-01T00:00:00Z`']) expect(result.markdown).toContain(text);
 expect(result.unmatched).toBe(2);
});
test('refuses truncated or capped database reads', () => {
 expect(() => assertComplete({truncated:true,tables:{answers:[]}})).toThrow('HOSTED_READ_TRUNCATED');
 expect(() => assertComplete({tables:{answers:Array(1000).fill({})}})).toThrow('HOSTED_READ_TRUNCATED');
 expect(() => assertComplete({tables:{answers:[]}})).not.toThrow();
});
test('publish lock refuses without modifying the lock', () => {
 const dir=mkdtempSync(join(tmpdir(),'nl-export-test-'));
 try {assertUnlocked(dir); writeFileSync(join(dir,'DEPLOY.lock'),'synthetic'); expect(() => assertUnlocked(dir)).toThrow('PUBLISH_LOCK');} finally {rmSync(dir,{recursive:true});}
});

const notePage = `<article data-decision="intro" data-title="Synthetic opening"><textarea></textarea></article>` + page;
const renderRows = (rows: ReturnType<typeof row>[]) => report({at:'synthetic-time',artifactHash:'synthetic-hash',shells:{'synthetic.html':notePage},rows}, ['synthetic']);
test('note-only card text attaches in page order and counts notes without decisions', () => {
 const result = renderRows([row('intro-free','Synthetic opening text'), row('intro-notes',[{text:'Extra note'}]), row('intro-checks','Checklist note')]);
 expect(result.counts.synthetic).toEqual({optionPicked:0,decisions:2,notesCards:1,noteOnlyDecisions:0});
 expect(result.unmatched).toBe(0);
 expect(result.markdown).toContain("Owner's text (verbatim JSON)");
 expect(result.markdown).toContain('free-text notes on 1 cards');
 expect(result.markdown.indexOf('Synthetic opening (note card)')).toBeLessThan(result.markdown.indexOf('Synthetic choice (decision)'));
 for (const key of ['intro-free','intro-notes','intro-checks']) expect(result.markdown.indexOf('key `'+key+'`')).toBeLessThan(result.markdown.indexOf('### 2.'));
});
test('empty note-card probe stays under its card without counting a note', () => {
 const result = renderRows([row('intro-free',null), row('intro-notes','')]);
 expect(result.counts.synthetic.notesCards).toBe(0);
 expect(result.unmatched).toBe(0);
 expect(result.markdown).toContain("empty (the publisher's probe uses this key)");
 expect(result.markdown.indexOf('key `intro-free`')).toBeLessThan(result.markdown.indexOf('### 2.'));
});
test('decision with note and no selected option counts as note only', () => {
 const result = renderRows([row('choice-free','Synthetic decision note')]);
 expect(result.counts.synthetic).toEqual({optionPicked:0,decisions:2,notesCards:1,noteOnlyDecisions:1});
 expect(result.markdown).toContain('0/2 decisions with an option picked');
 expect(result.markdown).toContain('Note only; no option picked.');
});
test('only keys that match no card appear as unmatched', () => {
 const result = renderRows([row('intro-free','Opening note'), row('orphan','Synthetic orphan')]);
 expect(result.unmatched).toBe(1);
 const unmatched = result.markdown.split('### Unmatched keys')[1];
 expect(unmatched).toContain('key `orphan`');
 expect(unmatched).not.toContain('intro-free');
 expect(result.markdown).not.toContain('publisher probe markers');
});
test('checkbox indices map to picked labels instead of the default on value', () => {
 const checkboxPage='<article data-decision="tasks" data-title="Tasks"><label><input type="checkbox" data-check-index="0">First item</label><label><input type="checkbox" data-check-index="1">Second item</label></article>';
 const result=report({at:'synthetic',artifactHash:'hash',shells:{'synthetic.html':checkboxPage},rows:[row('tasks-checks',['1'])]},['synthetic']);
 expect(result.markdown).toContain('First item [`0`]');expect(result.markdown).toContain('Second item [`1`]');expect(result.markdown).toContain('Picked options: Second item');
 expect(result.markdown).toContain('Picked;');expect(result.markdown).not.toContain("Owner's text");expect(result.counts.synthetic.optionPicked).toBe(1);
});
test('owners are grouped by hash without raw ids; served metadata escaped, values fenced', () => {
 const hostile='<article data-decision="x" data-title="Hello&#10;## Inject [link](url)"><label><input type="radio" name="x" value="yes">A&#10;**label**</label></article>';
 const result=report({at:'synthetic',artifactHash:'hash',shells:{'synthetic.html':hostile},rows:[{...row('x-free','[link](url) <img> ```'),ownerId:'owner-one'},{...row('x-free','Second'),ownerId:'owner-two'}]},['synthetic']);
 expect(result.markdown).toContain('2 owners; grouped by owner hash.');expect(result.markdown).not.toContain('owner-one');expect(result.markdown).not.toContain('owner-two');
 expect(result.markdown.match(/Owner `[a-f0-9]{12}`:/g)?.length).toBe(2);
 expect(result.markdown).toContain('Hello ## Inject \\[link\\](url)');expect(result.markdown).toContain('A \\*\\*label\\*\\*');
 expect(result.markdown).toContain('````json\n"[link](url) <img> ```"\n````');
});
test('unknown radio value is saved, not unanswered; bookkeeping has no values or unmatched count', () => {
 const result=renderRows([row('choice','maybe'),row('__position','PRIVATE_BOOKKEEPING'),row('__audio_manifest','PRIVATE_BOOKKEEPING'),row('_notes:choice-free','PRIVATE_BOOKKEEPING'),row('__future','PRIVATE_BOOKKEEPING')]);
 expect(result.markdown).toContain('Saved value not among the options');expect(result.markdown).not.toContain('Unanswered; no option picked.\n\n### 3');
 expect(result.counts.synthetic.optionPicked).toBe(0);expect(result.unmatched).toBe(0);expect(result.markdown).toContain('### App bookkeeping');expect(result.markdown).not.toContain('PRIVATE_BOOKKEEPING');
});
test('hostile served scripts cannot run or change the report', () => {
 const hostile=page+'<script>throw Error("SCRIPT_EXECUTED")</script><iframe src="javascript:throw Error(\'FRAME_EXECUTED\')"></iframe><script src="data:text/javascript,throw Error(\'REMOTE_SCRIPT_EXECUTED\')"></script>';
 expect(()=>report({at:'synthetic',artifactHash:'hash',shells:{'synthetic.html':hostile},rows:[]},['synthetic'])).not.toThrow();
});

test('metadata code spans preserve copyable ids, keys, hashes, revisions and timestamps', () => {
 const id='synthetic-2001-01-01', time='2001-01-01T12:23:05.192Z';
 const shell='<article data-decision="note-card" data-title="# leading&#10;# heading - v1.2: ready"><textarea></textarea></article>';
 const result=report({at:time,artifactHash:'sha256:synthetic-hash',shells:{[id+'.html']:shell},rows:[{...row('note-card-free','unchanged'),dashboardId:id,updatedAt:time},{...row('odd`key','unchanged'),dashboardId:id}]},[id]);
 for(const text of ['`'+id+'`','`'+time+'`','`note-card-free`','revision `3`','`sha256:synthetic-hash`','``odd`key``']) expect(result.markdown).toContain(text);
 expect(result.markdown).toContain('\\# leading # heading - v1.2: ready');
 expect(result.markdown).not.toContain('\n# heading');expect(result.markdown).not.toContain('synthetic\\-');
 expect(result.markdown).toContain('```json\n"unchanged"\n```');
});
