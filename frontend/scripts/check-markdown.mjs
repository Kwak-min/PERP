import assert from "node:assert/strict";

import { parseInline, parseMarkdown } from "../src/screens/vault/markdown.ts";

const cases = [];
function check(name, run) {
  try {
    run();
    cases.push(`ok ${name}`);
  } catch (error) {
    cases.push(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

check("heading level and text", () => {
  const blocks = parseMarkdown("### 회고");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "heading");
  assert.equal(blocks[0].level, 3);
  assert.deepEqual(blocks[0].inline, [{ kind: "text", value: "회고" }]);
});

check("unordered list groups consecutive items", () => {
  const blocks = parseMarkdown("- 하나\n- 둘\n- 셋");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "list");
  assert.equal(blocks[0].ordered, false);
  assert.equal(blocks[0].items.length, 3);
});

check("ordered list is separate from unordered", () => {
  const blocks = parseMarkdown("- 하나\n1. 둘");
  assert.deepEqual(
    blocks.map((block) => [block.kind, block.ordered]),
    [
      ["list", false],
      ["list", true],
    ],
  );
});

check("fenced code keeps raw body and language", () => {
  const blocks = parseMarkdown("```js\nconst a = 1;\n# not heading\n```");
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "code");
  assert.equal(blocks[0].language, "js");
  assert.equal(blocks[0].value, "const a = 1;\n# not heading");
});

check("quote and rule", () => {
  const blocks = parseMarkdown("> 인용\n\n---");
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ["quote", "rule"],
  );
});

check("blank line splits paragraphs", () => {
  const blocks = parseMarkdown("첫 단락\n계속\n\n둘째 단락");
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].inline[0].value, "첫 단락\n계속");
});

check("inline bold, italic, code", () => {
  assert.deepEqual(parseInline("**굵게** 와 *기울임* 과 `코드`"), [
    { kind: "bold", value: "굵게" },
    { kind: "text", value: " 와 " },
    { kind: "italic", value: "기울임" },
    { kind: "text", value: " 과 " },
    { kind: "code", value: "코드" },
  ]);
});

check("inline link and wikilink", () => {
  assert.deepEqual(parseInline("[문서](https://example.com) [[다른 노트]]"), [
    { kind: "link", value: "문서", href: "https://example.com" },
    { kind: "text", value: " " },
    { kind: "wikilink", value: "다른 노트" },
  ]);
});

check("html in source stays plain text", () => {
  const blocks = parseMarkdown('<img src=x onerror="alert(1)">');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "paragraph");
  assert.deepEqual(blocks[0].inline, [
    { kind: "text", value: '<img src=x onerror="alert(1)">' },
  ]);
});

check("empty source yields no blocks", () => {
  assert.deepEqual(parseMarkdown("   \n\n"), []);
});

for (const line of cases) console.log(line);
console.log(`MARKDOWN ${cases.filter((c) => c.startsWith("ok")).length}/${cases.length} passed`);
