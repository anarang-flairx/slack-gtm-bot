import type { App } from "@slack/bolt";
import type { KnownBlock } from "@slack/types";

/** Post a channel-visible message (not ephemeral). */
export async function postPublic(
  client: App["client"],
  channelId: string,
  text: string,
  blocks?: KnownBlock[],
): Promise<void> {
  await client.chat.postMessage({
    channel: channelId,
    text,
    ...(blocks ? { blocks } : {}),
  });
}

/** Post a message into a thread (falls back to channel root when no thread). */
export async function postThread(
  client: App["client"],
  channelId: string,
  threadTs: string | undefined,
  text: string,
  blocks?: KnownBlock[],
): Promise<void> {
  await client.chat.postMessage({
    channel: channelId,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text,
    ...(blocks ? { blocks } : {}),
  });
}
