function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatInlineMarkdown(line: string): string {
  let html = escapeHtml(line);

  html = html.replace(
    /\[([^\]]+)\]\(([^)]*)\)/g,
    (_match, label: string, url: string) => {
      const trimmedUrl = url.trim();
      if (
        !trimmedUrl ||
        trimmedUrl === "PLACEHOLDER-URL" ||
        !/^https?:\/\//i.test(trimmedUrl)
      ) {
        return escapeHtml(label);
      }
      const safeUrl = escapeHtml(trimmedUrl);
      return `<a href="${safeUrl}">${escapeHtml(label)}</a>`;
    },
  );

  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  return html;
}

function isBulletLine(line: string): boolean {
  return /^-\s+/.test(line);
}

function toBulletHtml(line: string): string {
  return `<li>${formatInlineMarkdown(line.replace(/^-\s+/, ""))}</li>`;
}

export function markdownToHtml(markdown: string): string {
  const blocks = markdown.trim().split(/\n{2,}/);
  const htmlBlocks: string[] = [];

  for (const block of blocks) {
    const lines = block.split("\n");

    if (lines.every((line) => line.trim() === "" || isBulletLine(line))) {
      const items = lines.filter((line) => line.trim()).map(toBulletHtml);
      htmlBlocks.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    const paragraph = lines
      .map((line) => formatInlineMarkdown(line))
      .join("<br>");

    htmlBlocks.push(`<p>${paragraph}</p>`);
  }

  return `<html><body style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.5;">${htmlBlocks.join("")}</body></html>`;
}

export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
      const trimmedUrl = url.trim();
      if (!trimmedUrl || trimmedUrl === "PLACEHOLDER-URL") {
        return label;
      }
      return `${label} (${trimmedUrl})`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "$1");
}
