import type { App } from "@slack/bolt";
import { buildDailyDigest } from "../digest/buildDailyDigest.js";
import { postPublic } from "../lib/slackPost.js";

export function registerDigestCommand(app: App): void {
  app.command("/digest", async ({ command, ack, client }) => {
    await ack();

    try {
      await postPublic(client, command.channel_id, "Building digest…");

      const digest = await buildDailyDigest();

      await client.chat.postMessage({
        channel: digest.channelId,
        text: "FlairX GTM Daily Digest",
        blocks: digest.blocks,
      });

      await postPublic(
        client,
        command.channel_id,
        `Posted digest to <#${digest.channelId}>.`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to build digest";

      await postPublic(client, command.channel_id, message);
    }
  });
}
