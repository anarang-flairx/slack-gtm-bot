export type SlackFile = {
  id?: string;
  mimetype?: string;
  filetype?: string;
  url_private?: string;
  url_private_download?: string;
};

/** Keep only image attachments (badges, cards, screenshots). */
export function imageFilesFrom(source: { files?: SlackFile[] }): SlackFile[] {
  return (source.files ?? []).filter((f) =>
    (f.mimetype ?? "").startsWith("image/"),
  );
}

/**
 * Download a Slack-hosted image (auth required) and return it as a base64
 * data URL suitable for an OpenAI vision `image_url` part.
 */
export async function fetchSlackImageAsDataUrl(
  file: SlackFile,
  botToken: string,
): Promise<string | null> {
  const url = file.url_private_download ?? file.url_private;
  if (!url) {
    return null;
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${botToken}` },
  });
  if (!res.ok) {
    throw new Error(`Slack file download failed (${res.status})`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const mimetype = file.mimetype ?? "image/png";
  return `data:${mimetype};base64,${buffer.toString("base64")}`;
}
