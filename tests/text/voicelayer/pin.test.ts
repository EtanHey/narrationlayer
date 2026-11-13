import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const folder = path.resolve(import.meta.dir, "../../../src/text/voicelayer");
const pins = {
  "display-tokens.ts": "5da77152f9580b384015ff56e22b347a5bd9fb43",
  "inline-code-spans.ts": "a28a4e577f83e37621d75055780dd50bf973f8c1",
  "markdown-to-speech.ts": "88731858441cb5c63ceaa941e5402fa7a4579351",
  "structured-speech.ts": "d67115aa3532a2efee781cda5f0901c9b48b6f32",
  "sections.ts": "5c27bffcae547f44dfa48209d322acabd5f5b8ea",
  "structured-display.ts": "55bcd5449bafa0e63de16ad5c4bfad8bac33c09c",
};

for (const [name, blob] of Object.entries(pins)) {
  test(`vendored files match their pinned blobs: ${name}`, () => {
    const bytes = readFileSync(path.join(folder, name));
    const actual = createHash("sha1")
      .update(`blob ${bytes.byteLength}\0`)
      .update(bytes)
      .digest("hex");
    expect(actual).toBe(blob);
  });
}

test("vendor folder contains exactly the pinned sources, README and LICENSE, with only internal imports", () => {
  const names = Object.keys(pins);
  expect(readdirSync(folder).sort()).toEqual([...names, "README.md", "LICENSE"].sort());
  for (const name of names) {
    const source = ts.createSourceFile(name, readFileSync(path.join(folder, name), "utf8"), ts.ScriptTarget.Latest, true);
    const check = (specifier: ts.Node | undefined) => {
      expect(specifier && ts.isStringLiteralLike(specifier), `${name}: literal import required`).toBe(true);
      if (!specifier || !ts.isStringLiteralLike(specifier)) return;
      expect(specifier.text.startsWith("./"), `${name}: ${specifier.text}`).toBe(true);
      const target = path.resolve(folder, specifier.text);
      expect(path.dirname(target), `${name}: ${specifier.text}`).toBe(folder);
      expect(names).toContain(path.basename(target).replace(/\.(?:m?js|ts)$/, "") + ".ts");
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) check(node.moduleSpecifier);
      } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))) check(node.arguments[0]);
      else if (ts.isImportTypeNode(node)) check(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined);
      else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) check(node.moduleReference.expression);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});
