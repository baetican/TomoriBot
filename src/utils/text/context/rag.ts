import { isRagAvailable } from "@/utils/db/ragAvailability";
import { llmModelRepo, ragRepository, serverMemoryRepository } from "@/utils/db/repositories";
import { log } from "@/utils/misc/logger";
import { resolveCapabilityCredentials, getResolvedCapabilityModelId } from "@/utils/provider/credentialResolver";
import { memoryGuard } from "@/utils/security/rateLimiter";
import { ContextItemTag, type StructuredContextItem } from "@/types/misc/context";
import type { TomoriState } from "@/types/db/schema";
import type { SimplifiedMessageForContext } from "./types";

const DOCUMENT_QUERY_MIN_LENGTH = 3;
const DOCUMENT_MAX_RESULTS = (() => {
  const parsed = Number.parseInt(process.env.DOCUMENT_MAX_RESULTS || "6", 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 6;
})();
const DOCUMENT_MIN_SIMILARITY = (() => {
  const parsed = Number.parseFloat(process.env.DOCUMENT_MIN_SIMILARITY || "0.5");
  return Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 0.5;
})();

// 3-lane weighted RAG query fusion: combined (recent dialogue) + user-only (intent
// signal) + memory (server/personal/STM content already resolved earlier in the
// same turn's pipeline). Replaces the single latest-user-message query so document
// retrieval can draw on more of the conversation and on curated long-term context.
const LANE_HISTORY_WINDOW = 8;
const COMBINED_LANE_MAX_LENGTH = 3000;
const USER_LANE_MAX_LENGTH = 1500;
const MEMORY_LANE_MAX_LENGTH = 1500;
const COMBINED_LANE_WEIGHT = 0.4;
const USER_LANE_WEIGHT = 0.4;
const MEMORY_LANE_WEIGHT = 0.2;

function isEligibleForLaneQuery(
  msg: SimplifiedMessageForContext,
): msg is SimplifiedMessageForContext & { content: string } {
  if (!msg.content) return false;
  if (msg.authorId === "0") return false;
  const trimmed = msg.content.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("[System:")) return false;
  return true;
}

// Caps keep the oldest end of the window (most recent content survives truncation).
function truncateFromOldestEnd(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(text.length - maxLength) : text;
}

function buildCombinedLaneQuery(messages: SimplifiedMessageForContext[]): string | null {
  const eligible = messages.filter(isEligibleForLaneQuery).slice(-LANE_HISTORY_WINDOW);
  if (eligible.length === 0) return null;
  const text = eligible.map((msg) => `${msg.authorName}: ${msg.content.trim()}`).join("\n");
  return truncateFromOldestEnd(text, COMBINED_LANE_MAX_LENGTH);
}

function buildUserLaneQuery(messages: SimplifiedMessageForContext[]): string | null {
  const eligible = messages.filter(isEligibleForLaneQuery).slice(-LANE_HISTORY_WINDOW);
  const userText = eligible
    .filter((msg) => msg.authorType === "user")
    .map((msg) => msg.content.trim())
    .join("\n");
  if (!userText) return null;
  return truncateFromOldestEnd(userText, USER_LANE_MAX_LENGTH);
}

function buildMemoryLaneQuery(memoryTexts: string[]): string | null {
  const joined = memoryTexts
    .map((text) => text?.trim())
    .filter((text): text is string => !!text)
    .join("\n");
  if (!joined) return null;
  return joined.length > MEMORY_LANE_MAX_LENGTH ? joined.slice(0, MEMORY_LANE_MAX_LENGTH) : joined;
}

export async function buildServerDocumentContextItem(params: {
  tomoriState: TomoriState | null | undefined;
  simplifiedMessageHistory: SimplifiedMessageForContext[];
  triggererUserId?: number;
  channelName?: string | null;
  /** Raw memory content (server/personal/STM) already resolved earlier this turn. */
  memoryLaneTexts?: string[];
}): Promise<StructuredContextItem | null> {
  try {
    const { tomoriState, simplifiedMessageHistory, triggererUserId, channelName, memoryLaneTexts } = params;
    if (!isRagAvailable() || memoryGuard.getStatus() === "critical" || !tomoriState?.server_id) {
      return null;
    }

    const candidateLanes: Array<{ text: string | null; weight: number }> = [
      { text: buildCombinedLaneQuery(simplifiedMessageHistory), weight: COMBINED_LANE_WEIGHT },
      { text: buildUserLaneQuery(simplifiedMessageHistory), weight: USER_LANE_WEIGHT },
      { text: buildMemoryLaneQuery(memoryLaneTexts ?? []), weight: MEMORY_LANE_WEIGHT },
    ];
    const lanes = candidateLanes.filter(
      (lane): lane is { text: string; weight: number } => !!lane.text && lane.text.length >= DOCUMENT_QUERY_MIN_LENGTH,
    );

    if (lanes.length === 0) {
      return null;
    }

    const hasDocument = await serverMemoryRepository.hasDocumentInScope(
      tomoriState.server_id,
      tomoriState.persona_id ?? null,
    );
    if (!hasDocument) {
      return null;
    }

    const creds = await resolveCapabilityCredentials(tomoriState.server_id, "embedding", {
      userId: triggererUserId ?? null,
    });
    const resolvedEmbeddingModelId =
      getResolvedCapabilityModelId(creds, "embedding") ?? tomoriState.config.embedding_model_id;
    const embeddingModel = resolvedEmbeddingModelId
      ? await llmModelRepo.loadEmbeddingModelById(resolvedEmbeddingModelId)
      : null;
    if (!embeddingModel) {
      return null;
    }

    const channelFilter = tomoriState.config.channel_memory_enabled && channelName ? channelName : null;

    const chunks = await ragRepository.retrieveRelevantChunks({
      serverId: tomoriState.server_id,
      personaId: tomoriState.persona_id ?? null,
      queries: lanes,
      embeddingModel,
      apiKey: creds.apiKey,
      maxResults: DOCUMENT_MAX_RESULTS,
      minSimilarity: DOCUMENT_MIN_SIMILARITY,
      channelName: channelFilter,
    });

    const documentContext = ragRepository.formatChunksForPrompt(chunks);
    if (!documentContext) {
      return null;
    }

    return {
      role: "user",
      parts: [{ type: "text", text: documentContext }],
      metadataTag: ContextItemTag.KNOWLEDGE_SERVER_DOCUMENTS,
    };
  } catch (error) {
    log.warn("Failed to add server document context", error);
    return null;
  }
}
