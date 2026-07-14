import { readFileSync } from "node:fs";
import { join } from "node:path";

export type EmailTemplate = {
  subject: string;
  body: string;
};

export type TemplateContext = Record<string, string>;

const templatesDir = join(process.cwd(), "src/templates");

export function loadTemplate(filename: string): EmailTemplate {
  const raw = readFileSync(join(templatesDir, filename), "utf8").trim();
  const lines = raw.split("\n");

  if (!lines[0]?.startsWith("Subject:")) {
    throw new Error(`Template ${filename} must start with "Subject:"`);
  }

  const subject = lines[0].replace(/^Subject:\s*/, "").trim();
  const body = lines.slice(1).join("\n").trim();

  return { subject, body };
}

export function fillTemplate(
  template: EmailTemplate,
  context: TemplateContext,
): EmailTemplate {
  const replace = (text: string) =>
    text.replace(/\{([a-z_]+)\}/g, (match, key: string) => {
      return context[key] ?? match;
    });

  return {
    subject: replace(template.subject),
    body: replace(template.body),
  };
}
