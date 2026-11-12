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
 expect(result.counts.synthetic).toEqual({answered:1,decisions:2});
 for (const text of ['Synthetic choice','Alpha label','Beta label','"Beta"','line one\\nline two','Unanswered.','Empty/probe marker; key probe','Unmatched; key unknown','revision 3','2001-01-01']) expect(result.markdown).toContain(text);
 expect(result.unmatched).toBe(1);
});
test('refuses truncated or capped database reads', () => {
 expect(() => assertComplete({truncated:true,tables:{answers:[]}})).toThrow('truncated');
 expect(() => assertComplete({tables:{answers:Array(1000).fill({})}})).toThrow('truncated');
 expect(() => assertComplete({tables:{answers:[]}})).not.toThrow();
});
test('publish lock refuses without modifying the lock', () => {
 const dir=mkdtempSync(join(tmpdir(),'nl-export-test-'));
 try {assertUnlocked(dir); writeFileSync(join(dir,'DEPLOY.lock'),'synthetic'); expect(() => assertUnlocked(dir)).toThrow('Publish lock');} finally {rmSync(dir,{recursive:true});}
});
