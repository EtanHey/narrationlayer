// Synchronous spawns in tests go through tests/support/spawn.ts, whose helpers require a timeout.
// The rule is textual and specified by construction: the forbidden names may not appear ANYWHERE in a covered file
// (code, string, comment, any syntax) other than the helper module or a listed exception. No call parsing, no list
// of call forms. Before matching, the file's text is read the way the JavaScript lexer reads it: every escape form
// of the ECMAScript string grammar is decoded (the table in the test names each production), over the whole text,
// so an escaped or line-split spelling is still the name.
// Covered: every tracked file under tests/, and every tracked JavaScript or TypeScript file under packages/
// (.js .mjs .cjs .jsx .ts .mts .cts .tsx) whatever its name, so a new file is covered by default.
// It cannot see: a name computed while the program runs (concatenation, interpolation, join, a lookup table).
// Deliberate edges: Python tests and helpers (packages/dashboard-publish/test_*.py, ratchet.py) are outside this
// JavaScript rule (follow-up P3.G8); product code under src/, bin/ and scripts/ that a test imports is product
// behaviour, not test code. Bun.$ is asynchronous, so it is not a synchronous spawn and not on the list.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { nodeSpawnChecked, spawnChecked } from "../support/spawn.js";

const root = path.resolve(import.meta.dir, "../..");
// Written so that this file does not itself contain the names it forbids.
const FORBIDDEN = /spawn[S]ync|exec[F]ileSync|exec[S]ync/g;
const SCOPE = ["tests", ...["js", "mjs", "cjs", "jsx", "ts", "mts", "cts", "tsx"].map((ext) => `:(glob)packages/**/*.${ext}`)];
const HELPERS = new Set(["tests/support/spawn.ts"]);
// Files left out on purpose, each with its reason. A stale entry (gone, or no longer naming a spawn) fails.
const EXCEPTIONS = new Map<string, string>([
  ["packages/dashboard-publish/answers-export.mjs", "product code, not a test: the publisher command runs the capsule's readback script"],
]);

const CONTROL: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };

/** The text as the JavaScript lexer reads it, with each decoded character's index in the original text. After a
 * backslash comes exactly one production of ECMA-262's EscapeSequence or LineContinuation, decoded in this order:
 * a line continuation, \u{...} / \uXXXX / \xXX, a legacy octal escape, a control letter, else the identity escape. */
function lexerText(source: string): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  const emit = (chars: string, from: number) => { text += chars; for (let k = 0; k < chars.length; k++) at.push(from); };
  for (let i = 0; i < source.length;) {
    if (source[i] === "\\") {
      const rest = source.slice(i);
      if (rest.length === 1) { text += "\\"; at.push(i); i += 1; continue; }
      const continuation = /^\\(?:\r\n|[\n\r\u2028\u2029])/.exec(rest);
      if (continuation) { i += continuation[0].length; continue; }
      const escape = /^\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/.exec(rest);
      if (escape) {
        const code = Number.parseInt(escape[1] ?? escape[2] ?? escape[3]!, 16);
        if (code <= 0x10ffff) { emit(String.fromCodePoint(code), i); i += escape[0].length; continue; }
      }
      const octal = /^\\(?:[0-3][0-7]{0,2}|[4-7][0-7]?)/.exec(rest);
      if (octal) { emit(String.fromCharCode(Number.parseInt(octal[0].slice(1), 8)), i); i += octal[0].length; continue; }
      // b f n r t v are control characters; every other character (8, 9, quotes, `$`, a second backslash, and the
      // u or x of a malformed escape) is itself: the identity escape. Either way the character after it starts nothing.
      const next = rest[1]!;
      emit(CONTROL[next] ?? next, i); i += 2; continue;
    }
    emit(source[i]!, i); i += 1;
  }
  return { text, at };
}

/** Every forbidden name in `source`, as `line: name`, the line being that of the match's first character in the original. */
function forbiddenMentions(source: string): string[] {
  const { text, at } = lexerText(source);
  const lineOf = (index: number) => source.slice(0, index).split(/\r\n|\r|\n|\u2028|\u2029/).length;
  return [...text.matchAll(FORBIDDEN)].map((m) => `${lineOf(at[m.index!]!)}: ${m[0]}`);
}

const trackedInScope = () => {
  const listed = nodeSpawnChecked("git", ["ls-files", "-z", "--", ...SCOPE], { cwd: root, timeout: 20_000 });
  expect(listed.status, listed.stderr).toBe(0);
  return listed.stdout.split("\0").filter(Boolean);
};

test("no covered file names a synchronous spawn outside tests/support/spawn.ts and the listed exceptions", () => {
  const files = trackedInScope();
  expect(files).toContain("tests/support/spawn.ts");
  expect(files).toContain("packages/dashboard-publish/answers-export-capsule.test.ts");
  expect(files).toContain("packages/dashboard-publish/fixtures/answer-runtimes/current.js"); // not *.test.*, still covered
  const found: string[] = [];
  for (const file of files) {
    if (HELPERS.has(file) || EXCEPTIONS.has(file)) continue;
    for (const mention of forbiddenMentions(readFileSync(path.join(root, file), "latin1"))) found.push(`${file}:${mention}`);
  }
  expect(found).toEqual([]);
}, 30_000);

test("every exception still exists, is in scope and still names a synchronous spawn", () => {
  const files = new Set(trackedInScope());
  for (const [file, reason] of EXCEPTIONS) {
    expect(reason.length, file).toBeGreaterThan(0);
    expect(files.has(file), `${file} is not a tracked file in scope`).toBe(true);
    expect(existsSync(path.join(root, file)), file).toBe(true);
    expect(forbiddenMentions(readFileSync(path.join(root, file), "latin1")).length, `${file} no longer names a spawn: drop the exception`).toBeGreaterThan(0);
  }
}, 30_000);

test("the matcher reads escapes and line continuations; only a name computed at run time escapes it", () => {
  // Probe texts are built here at run time, so this file never spells the names (the documented limit, used on purpose).
  const BS = "\\";
  const S = "spawn" + "Sync", E = "exec" + "FileSync", X = "exec" + "Sync";
  const reported = {
    "reviewer probe 1: bracket key with a unicode escape": `Bun["spawn${BS}u0053ync"](["sleep", "37"]);`,
    "reviewer probe 2: a line continuation between spawn and Sync": `Bun["spawn${BS}\nSync"](["sleep", "37"]);`,
    "code-point escape": `Bun["spawn${BS}u{53}ync"]([]);`,
    "hex escape": `Bun["spawn${BS}x53ync"]([]);`,
    "CRLF line continuation": `Bun["spawn${BS}\r\nSync"]([]);`,
    "escaped bare identifier": `import { spawn${BS}u0053ync } from "node:child_process";\nspawn${BS}u0053ync("ls");`,
    "historical: bracket key": `Bun["${S}"](["sleep", "37"]);`,
    "historical: parenthesised callee": `(Bun.${S})(["sleep", "37"]);`,
    "historical: timeout in an ignored argument": `Bun.${S}(["sleep", "37"], {}, { timeout: 1 });`,
    "alias": `import { ${S} as run } from "node:child_process";`,
    "namespace import": `import * as cp from "node:child_process";\ncp.${S}("ls");`,
    "the other names": `${E}("ls");\n${X}("ls");`,
  };
  expect(forbiddenMentions(reported["reviewer probe 1: bracket key with a unicode escape"])).toEqual([`1: ${S}`]);
  expect(forbiddenMentions(reported["reviewer probe 2: a line continuation between spawn and Sync"])).toEqual([`1: ${S}`]);
  expect(forbiddenMentions(reported["CRLF line continuation"])).toEqual([`1: ${S}`]);
  expect(forbiddenMentions(reported["escaped bare identifier"])).toEqual([`1: ${S}`, `2: ${S}`]);
  expect(forbiddenMentions(reported["namespace import"])).toEqual([`2: ${S}`]);
  expect(forbiddenMentions(reported["the other names"])).toEqual([`1: ${E}`, `2: ${X}`]);
  for (const [name, text] of Object.entries(reported)) expect(forbiddenMentions(text).length, name).toBeGreaterThan(0);
  // A match is reported on the line of its first character, after a multi-line prefix.
  expect(forbiddenMentions(`// one\n// two\nBun["spawn${BS}\nSync"]([]);`)).toEqual([`3: ${S}`]);
  // Not reported: an unrelated escape, an escaped backslash before a u, and the documented limit.
  expect(forbiddenMentions(`const tab = "a${BS}u0009b"; const nl = "${BS}x0a";`)).toEqual([]);
  expect(forbiddenMentions(`const p = "spawn${BS}${BS}u0053ync";`)).toEqual([]);
  expect(forbiddenMentions(`const name = "spawn" + "Sync"; Bun[name]([]);`)).toEqual([]); // LIMIT: computed at run time
});

test("every production of the ECMAScript escape grammar is decoded, one row each", () => {
  const BS = "\\", LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
  const S = "spawn" + "Sync", E = "exec" + "FileSync";
  // [production, source text, what lexerText makes of it]
  const rows: [string, string, string][] = [
    ["LineContinuation: LF", `a${BS}\nb`, "ab"],
    ["LineContinuation: CRLF", `a${BS}\r\nb`, "ab"],
    ["LineContinuation: CR", `a${BS}\rb`, "ab"],
    ["LineContinuation: U+2028", `a${BS}${LS}b`, "ab"],
    ["LineContinuation: U+2029", `a${BS}${PS}b`, "ab"],
    ["UnicodeEscapeSequence: u{...}", `${BS}u{000053}`, "S"],
    ["UnicodeEscapeSequence: uXXXX", `${BS}u0053`, "S"],
    ["HexEscapeSequence: xXX", `${BS}x53`, "S"],
    ["LegacyOctalEscapeSequence: three digits", `${BS}123`, "S"],
    ["LegacyOctalEscapeSequence: [4-7][0-7]", `${BS}46x`, "&x"],
    ["LegacyOctalEscapeSequence: a 4 stops after two digits", `${BS}477`, "'7"],
    ["LegacyOctalEscapeSequence: \\0 is NUL", `${BS}0`, "\0"],
    ["NonOctalDecimalEscapeSequence: 8", `${BS}8`, "8"],
    ["NonOctalDecimalEscapeSequence: 9", `${BS}9`, "9"],
    ["SingleEscapeCharacter: b f n r t v", `${BS}b${BS}f${BS}n${BS}r${BS}t${BS}v`, "\b\f\n\r\t\v"],
    ["SingleEscapeCharacter: quotes and backslash", `${BS}'${BS}"${BS}${BS}`, `'"${BS}`],
    ["NonEscapeCharacter (identity)", `${BS}S${BS}$${BS}\``, "S$`"],
    ["malformed u or x: the letter itself", `${BS}uZ${BS}xZ`, "uZxZ"],
  ];
  for (const [name, source, decoded] of rows) expect(lexerText(source).text, name).toBe(decoded);
  // The name through each production that can spell it.
  for (const source of [`spawn${BS}\nSync`, `spawn${BS}u{000053}ync`, `spawn${BS}u0053ync`, `spawn${BS}x53ync`, `spawn${BS}123ync`, `spawn${BS}Sync`, `s${BS}pawnSync`, `exec${BS}106ileSync`]) {
    expect(forbiddenMentions(source), source).toEqual([`1: ${source.startsWith("exec") ? E : S}`]);
  }
  // Not the name: a control letter is not its letter, an escaped backslash is one backslash and starts nothing.
  expect(forbiddenMentions(`spaw${BS}nSync`)).toEqual([]);
  expect(forbiddenMentions(`spawn${BS}${BS}Sync`)).toEqual([]);
  expect(forbiddenMentions(`spawn${BS}${BS}u0053ync`)).toEqual([]);
  // The reported line is the original line of the match's first character, after escapes that span lines.
  expect(forbiddenMentions(`x${BS}\n${BS}\ny\nspawn${BS}Sync`)).toEqual([`4: ${S}`]);
});

test("the helpers' timeout cannot be skipped: the type checker rejects a call without one and run time refuses it", () => {
  // @ts-expect-error timeout is required (checked by `bunx tsc --noEmit`)
  expect(() => nodeSpawnChecked("true", [], {})).toThrow("true: a synchronous spawn needs a positive finite timeout, got undefined");
  // @ts-expect-error timeout is required (checked by `bunx tsc --noEmit`)
  expect(() => spawnChecked(["true"], {})).toThrow("true: a synchronous spawn needs a positive finite timeout, got undefined");
  const bypass: any = { timeout: undefined };
  expect(() => nodeSpawnChecked("true", [], bypass)).toThrow("needs a positive finite timeout, got undefined");
  expect(() => spawnChecked(["true"], bypass)).toThrow("needs a positive finite timeout, got undefined");
  for (const timeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(() => nodeSpawnChecked("true", [], { timeout })).toThrow("needs a positive finite timeout");
    expect(() => spawnChecked(["true"], { timeout })).toThrow("needs a positive finite timeout");
  }
});

test("a helper call that outlives its timeout throws, naming the command", () => {
  expect(() => nodeSpawnChecked("sleep", ["5"], { timeout: 200 })).toThrow(/^sleep 5: .*ETIMEDOUT/);
  expect(() => spawnChecked(["sleep", "5"], { timeout: 200 })).toThrow("sleep 5: timed out after 200 ms");
  expect(() => nodeSpawnChecked("nl-no-such-command", [], { timeout: 2000 })).toThrow(/^nl-no-such-command: /);
  expect(nodeSpawnChecked("sh", ["-c", "echo out; echo err >&2; exit 3"], { timeout: 2000 })).toEqual({ status: 3, stdout: "out\n", stderr: "err\n" });
}, 10_000);
