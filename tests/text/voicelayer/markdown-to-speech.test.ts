import { describe, expect, it } from "bun:test";
import { markdownToSpeech } from "../../../src/text/voicelayer/markdown-to-speech";

describe("markdownToSpeech", () => {
  for (const [input, output] of [
    ["# Heading\n\n**Bold** and _italic_ with `code`.", "Heading Bold and italic with code."],
    ["[VoiceLayer](https://example.com) and https://example.org/path", "VoiceLayer and link"],
    ["Before\n```ts\nconst secret = 42;\n```\nAfter", "Before code block After"],
    ["Before\n~~~python\nprint('hello')\n~~~\nAfter", "Before code block After"],
    ["- One\n* Two\n3. Three", "One. Two. 3. Three."],
    ["| Name | Value |\n| --- | ---: |\n| A | 5 |", "Name, Value. A, 5."],
    ["שלום **עולם**", "שלום עולם"],
    ["Title\n=====\nVisit <https://example.com>.", "Title Visit link."],
    ["[A link](https://example.com/a_(b))", "A link"],
    ["A sentence.\n- Another sentence!", "A sentence. Another sentence!"],
  ]) it(`converts ${JSON.stringify(input)}`, () => expect(markdownToSpeech(input)).toBe(output));
  it("R1-3 preserves prose when a selection starts inside code before its closing fence", () => {
    expect(markdownToSpeech("const value = 1;\nconsole.log(value);\n```\nHere is the explanation.\nContinue reading."))
      .toBe("code block Here is the explanation. Continue reading.");
  });
  it("R1-3 preserves prose after an unmatched leading bare fence", () => {
    expect(markdownToSpeech("```\nHere is the explanation.\n- First point\n- Second point"))
      .toBe("code block Here is the explanation. First point. Second point.");
  });
  it("R1-3 preserves prose after an unclosed opening fence instead of swallowing the rest", () => {
    expect(markdownToSpeech("Hi\n```js\nsecret()\nAfter this incomplete example, keep this sentence."))
      .toBe("Hi code block After this incomplete example, keep this sentence.");
  });
  it("R1-3 a selection ending mid-code omits only recognizable code", () => {
    expect(markdownToSpeech("Before the example.\n```ts\nconst value = 1;\nconsole.log(value)"))
      .toBe("Before the example. code block");
  });
  it("R1-3 a leading closing fence does not steal the later code block's closing fence", () => {
    expect(markdownToSpeech("```\nHere is the explanation.\n```js\nconst next = 2;\n```\nMore prose."))
      .toBe("code block Here is the explanation. code block More prose.");
  });
  it("R1-3 a leading unmatched fence keeps unpunctuated prose instead of stealing a later closer", () => {
    expect(markdownToSpeech("```\nHere is the explanation\n```js\nconst next = 2;\n```\nMore prose."))
      .toBe("code block Here is the explanation code block More prose.");
    expect(markdownToSpeech("```\nExplanation continues here forever\n```js\nx\n```\nMore."))
      .toBe("code block Explanation continues here forever code block More.");
  });
  it("keeps a complete bare fence as one code block even when the body starts like a list", () => {
    expect(markdownToSpeech("Before\n```\n- item one\n- item two\n```\nAfter"))
      .toBe("Before code block After");
  });
  it("keeps a complete bare fence as one code block when the body starts like a sentence", () => {
    expect(markdownToSpeech("Before\n```\nThis looks like prose inside the fence.\nfoo();\n```\nAfter"))
      .toBe("Before code block After");
  });
  it("N1 retains bracketed citation prose after an incomplete fence", () => {
    expect(markdownToSpeech("Hi\n```js\nsecret()\n[citation needed]"))
      .toBe("Hi code block [citation needed]");
  });
  it("retains prose when a mid-code selection ends inside another bare fence", () => {
    expect(markdownToSpeech("x = 1;\ny = 2;\n```\nHere is the explanation.\n```\nsecret()"))
      .toBe("code block Here is the explanation. code block");
  });
  it("collapses strong code after a recovered prefix closing fence", () => {
    expect(markdownToSpeech("x = 1;\n```\nfoo();\nbar();\n```\nAfter"))
      .toBe("code block code block After");
  });
  it("retains ambiguous prose while filtering code after a recovered prefix closing fence", () => {
    expect(markdownToSpeech("x = 1;\n```\nThis looks like prose inside the fence.\nfoo();\n```\nAfter"))
      .toBe("code block This looks like prose inside the fence. code block After");
    expect(markdownToSpeech("x = 1;\n```\n- item one\n- item two\n```\nAfter"))
      .toBe("code block item one. item two. code block After");
  });
  for (const [kind, prefix] of [["literal assignments", "x = 1\ny = 2"], ["a return statement", "return 1;"], ["a code comment", "// initialize state\nx = 1;"]]) {
    it(`retains trailing prose after ${kind} before a bare closing fence`, () => {
      expect(markdownToSpeech(`${prefix}\n\`\`\`\nHere is the explanation.\n\`\`\`\nsecret()`))
        .toBe("code block Here is the explanation. code block");
    });
  }
  it("retains sentences and uncertain assignments during prefix recovery", () => {
    for (const prefix of ["x = one idea among many", "return this idea carefully.", "# This is a heading"]) {
      expect(markdownToSpeech(`${prefix}\n\`\`\`\nHere is the explanation.`))
        .toBe(`${prefix.replace(/^# /, "")} code block Here is the explanation.`);
    }
  });
  for (const identifier of ["voice_ask", "snake_case_name", "__init__"]) {
    it(`R1-4 preserves identifier ${identifier}`, () => expect(markdownToSpeech(identifier)).toBe(identifier));
  }
  it("R1-4 strips real emphasis at word boundaries without touching adjacent identifiers", () => {
    expect(markdownToSpeech("Use voice_ask and snake_case_name with _emphasis_ or (__init__)."))
      .toBe("Use voice_ask and snake_case_name with emphasis or (__init__).");
  });
  it("N1 retains import-led prose after an incomplete fence", () => {
    expect(markdownToSpeech("Hi\n```js\nsecret()\nimport this idea carefully."))
      .toBe("Hi code block import this idea carefully.");
  });
  it("N1 retains from-led prose after an incomplete fence", () => {
    expect(markdownToSpeech("Hi\n```js\nsecret()\nfrom experience, avoid that."))
      .toBe("Hi code block from experience, avoid that.");
  });
  it("N1 retains const-led prose after an incomplete fence", () => {
    expect(markdownToSpeech("Hi\n```js\nsecret()\nconst foo = bar is wrong though."))
      .toBe("Hi code block const foo = bar is wrong though.");
  });
  it("N1 collapses strongly evidenced code after an incomplete fence", () => {
    for (const code of ['import x from "y"', 'from math import (sqrt)', 'const x = 1;', 'name()', 'x = 1;', 'values = [1, 2]', 'if (ready) {']) {
      expect(markdownToSpeech(`Hi\n\`\`\`js\n${code}`)).toBe("Hi code block");
    }
  });
  it("N1 retains four-word prose and sentence punctuation despite code-like prefixes", () => {
    for (const prose of ['import this idea carefully', 'from experience avoid that', 'from math import sqrt', 'const ideas are worth discussing', '    import this idea carefully.', 'name() is helpful, right?', 'Call name()!', 'name() // useful in practice.']) {
      expect(markdownToSpeech(`Hi\n\`\`\`js\n${prose}`)).toBe(`Hi code block ${prose.trim()}`);
    }
  });
  it("N2 collapses unprefixed assignments before a leading closing fence", () => {
    expect(markdownToSpeech("x = 1;\ny = 2;\n```\nHere is the explanation."))
      .toBe("code block Here is the explanation.");
  });
  it("N2 retains ambiguous leading prose before a closing fence", () => {
    expect(markdownToSpeech("const foo = bar is wrong though.\n```\nHere is the explanation."))
      .toBe("const foo = bar is wrong though. code block Here is the explanation.");
  });

});
