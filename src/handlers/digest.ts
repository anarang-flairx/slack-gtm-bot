import type { App } from "@slack/bolt";
import { buildDailyDigest } from "../digest/buildDailyDigest.js";

export function registerDigestCommand(app: App): void {
  app.command("/digest", async ({ command, ack, client }) => {
    await ack();

    try {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Building digest…",
      });

      const digest = await buildDailyDigest();

      await client.chat.postMessage({
        channel: digest.channelId,
        text: "FlairX GTM Daily Digest",
        blocks: digest.blocks,
      });

      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `Posted digest to <#${digest.channelId}>.`,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to build digest";

      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: message,
      });
    }
  });
}
