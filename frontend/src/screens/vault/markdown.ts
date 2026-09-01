/**
 * 개인 노트용 마크다운 파서.
 * HTML 문자열을 만들지 않고 토큰만 돌려준다. 렌더는 React가 하므로
 * 본문에 들어온 태그는 항상 그냥 글자로 표시된다(주입 여지 없음).
 */

export type Inline =
  | Readonly<{ kind: "text"; value: string }>
  | Readonly<{ kind: "bold"; value: string }>
  | Readonly<{ kind: "italic"; value: string }>
  | Readonly<{ kind: "code"; value: string }>
  | Readonly<{ kind: "link"; value: string; href: string }>
  | Readonly<{ kind: "wikilink"; value: string }>;

export type Block =
  | Readonly<{ kind: "heading"; level: number; inline: readonly Inline[] }>
  | Readonly<{ kind: "paragraph"; inline: readonly Inline[] }>
  | Readonly<{ kind: "quote"; inline: readonly Inline[] }>
  | Readonly<{ kind: "list"; ordered: boolean; items: readonly (readonly Inline[])[] }>
  | Readonly<{ kind: "code"; language: string; value: string }>
  | Readonly<{ kind: "rule" }>;

const INLINE_PATTERN =
  /(\*\*[^*]+\*\*|(?<!\*)\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[\[[^\]]+\]\]|\[[^\]]+\]\([^)\s]+\))/g;

export function parseInline(text: string): readonly Inline[] {
  const out: Inline[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) out.push({ kind: "text", value: text.slice(cursor, index) });
    const token = match[0];
    if (token.startsWith("**")) {
      out.push({ kind: "bold", value: token.slice(2, -2) });
    } else if (token.startsWith("`")) {
      out.push({ kind: "code", value: token.slice(1, -1) });
    } else if (token.startsWith("[[")) {
      out.push({ kind: "wikilink", value: token.slice(2, -2) });
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      out.push({
        kind: "link",
        value: token.slice(1, split),
        href: token.slice(split + 2, -1),
      });
    } else {
      out.push({ kind: "italic", value: token.slice(1, -1) });
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) out.push({ kind: "text", value: text.slice(cursor) });
  return out.length > 0 ? out : [{ kind: "text", value: "" }];
}

function listMatch(line: string): Readonly<{ ordered: boolean; body: string }> | null {
  const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
  if (unordered) return { ordered: false, body: unordered[1] ?? "" };
  const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
  if (ordered) return { ordered: true, body: ordered[1] ?? "" };
  return null;
}

export function parseMarkdown(source: string): readonly Block[] {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", inline: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      blocks.push({ kind: "code", language: fence[1] ?? "", value: body.join("\n") });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushParagraph();
      blocks.push({ kind: "rule" });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({
        kind: "heading",
        level: (heading[1] ?? "#").length,
        inline: parseInline(heading[2] ?? ""),
      });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      blocks.push({ kind: "quote", inline: parseInline(quote[1] ?? "") });
      continue;
    }

    const item = listMatch(line);
    if (item) {
      flushParagraph();
      const items: (readonly Inline[])[] = [parseInline(item.body)];
      const ordered = item.ordered;
      while (index + 1 < lines.length) {
        const next = listMatch(lines[index + 1] ?? "");
        if (!next || next.ordered !== ordered) break;
        items.push(parseInline(next.body));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  return blocks;
}
