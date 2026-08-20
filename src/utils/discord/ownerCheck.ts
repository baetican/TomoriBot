/**
 * Bot-owner permission gate for owner-only commands (e.g. cross-user personal
 * memory retcons). Distinct from per-guild `ManageGuild` checks: this is a
 * global allowlist, not scoped to any server.
 */

/**
 * Returns true if the given Discord user snowflake is listed in BOT_OWNER_IDS.
 * Unset or blank BOT_OWNER_IDS disables owner-only commands entirely.
 *
 * @param discordUserId - Discord user snowflake to check
 */
export function isBotOwner(discordUserId: string): boolean {
  const ownerIds = (process.env.BOT_OWNER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return ownerIds.includes(discordUserId);
}
