export type SlackFile = {
  id?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

/** OpenAI vision image_url supports these MIME types. */
const VISION_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/** Slack iOS often uploads HEIC — gpt-4o cannot read it. */
const UNSUPPORTED_MIME = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

/** OpenAI limit is 20MB; leave headroom for base64 expansion. */
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export type ImageFileFilterResult = {
  images: SlackFile[];
  skippedUnsupported: number;
  skippedTooLarge: number;
};

function normalizeMime(file: SlackFile): string {
  return (file.mimetype ?? "").trim().toLowerCase();
}

/** True when Slack reports a vision-compatible image type. */
export function isVisionCompatibleImage(file: SlackFile): boolean {
  const mime = normalizeMime(file);
  if (!mime.startsWith("image/")) {
    return false;
  }
  if (UNSUPPORTED_MIME.has(mime)) {
    return false;
  }
  // Unknown image/* (e.g. image/tiff) — skip rather than fail at OpenAI.
  if (!VISION_MIME.has(mime)) {
    return false;
  }
  if (typeof file.size === "number" && file.size > MAX_IMAGE_BYTES) {
    return false;
  }
  return true;
}

/** Keep only vision-compatible image attachments (badges, cards, screenshots). */
export function imageFilesFrom(source: { files?: SlackFile[] }): SlackFile[] {
  return filterImageFiles(source).images;
}

export function filterImageFiles(source: {
  files?: SlackFile[];
}): ImageFileFilterResult {
  const images: SlackFile[] = [];
  let skippedUnsupported = 0;
  let skippedTooLarge = 0;

  for (const file of source.files ?? []) {
    const mime = normalizeMime(file);
    if (!mime.startsWith("image/")) {
      continue;
    }
    if (UNSUPPORTED_MIME.has(mime) || !VISION_MIME.has(mime)) {
      skippedUnsupported += 1;
      continue;
    }
    if (typeof file.size === "number" && file.size > MAX_IMAGE_BYTES) {
      skippedTooLarge += 1;
      continue;
    }
    images.push(file);
  }

  return { images, skippedUnsupported, skippedTooLarge };
}

/**
 * Download a Slack-hosted image (auth required) and return it as a base64
 * data URL suitable for an OpenAI vision `image_url` part.
 */
export async function fetchSlackImageAsDataUrl(
  file: SlackFile,
  botToken: string,
): Promise<string | null> {
  if (!isVisionCompatibleImage(file)) {
    return null;
  }

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
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    return null;
  }

  const mimetype = normalizeMime(file) || "image/png";
  return `data:${mimetype};base64,${buffer.toString("base64")}`;
}
