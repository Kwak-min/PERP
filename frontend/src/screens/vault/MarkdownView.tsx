import { createElement, type ReactNode } from "react";

import { parseMarkdown, type Inline } from "./markdown";

function renderInline(inline: readonly Inline[]): readonly ReactNode[] {
  return inline.map((token, index) => {
    switch (token.kind) {
      case "bold":
        return <strong key={index}>{token.value}</strong>;
      case "italic":
        return <em key={index}>{token.value}</em>;
      case "code":
        return <code key={index}>{token.value}</code>;
      case "link":
        return (
          <a key={index} href={token.href} target="_blank" rel="noreferrer noopener">
            {token.value}
          </a>
        );
      case "wikilink":
        return (
          <span key={index} className="md-wikilink">
            {token.value}
          </span>
        );
      default:
        return <span key={index}>{token.value}</span>;
    }
  });
}

/** 파서가 만든 토큰만 React 요소로 바꾼다. 원문 HTML은 항상 글자로 남는다. */
export function MarkdownView({ source }: Readonly<{ source: string }>) {
  const blocks = parseMarkdown(source);
  if (blocks.length === 0) {
    return <p className="md-empty">미리볼 내용이 없습니다. 왼쪽 편집 탭에서 마크다운으로 작성하세요.</p>;
  }

  return (
    <div className="md-body">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return createElement(
              `h${Math.min(block.level + 1, 6)}`,
              { key: index },
              renderInline(block.inline),
            );
          case "quote":
            return <blockquote key={index}>{renderInline(block.inline)}</blockquote>;
          case "code":
            return (
              <pre key={index} data-language={block.language || undefined}>
                <code>{block.value}</code>
              </pre>
            );
          case "rule":
            return <hr key={index} />;
          case "list":
            return createElement(
              block.ordered ? "ol" : "ul",
              { key: index },
              block.items.map((item, itemIndex) => <li key={itemIndex}>{renderInline(item)}</li>),
            );
          default:
            return <p key={index}>{renderInline(block.inline)}</p>;
        }
      })}
    </div>
  );
}
