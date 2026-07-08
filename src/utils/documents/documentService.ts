import { sql } from "@/utils/db/client";
import { log } from "@/utils/misc/logger";
import { generateEmbeddingsBatched, providerSupportsEmbeddingTaskType } from "@/utils/embeddings/embeddingProvider";
import type { EmbeddingModelRow } from "@/types/db/schema";

export interface RetrievedDocumentChunk {
  document_id: number;
  document_name: string;
  chunk_index: number;
  content: string;
  similarity: number;
}

export function normalizeDocumentText(text: string): string {
  return text
    .replaceAll("\u0000", "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function chunkDocumentText(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];

  if (chunkSize <= 0) {
    return chunks;
  }

  const safeOverlap = Math.max(0, Math.min(overlap, Math.max(0, chunkSize - 1)));
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    if (end >= text.length) {
      break;
    }
    start = Math.max(0, end - safeOverlap);
  }

  return chunks;
}

export function formatVector(values: number[]): string {
  return `[${values.join(",")}]`;
}

// postgres.js passes JS arrays as plain toString() output for TEXT[] columns, which PostgreSQL
// rejects ("Array value must start with {"). Format explicitly as a PostgreSQL array literal.
function toPgTextArray(values: string[]): string {
  if (values.length === 0) return "{}";
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

/**
 * Creates a document record without chunks. Use with appendDocumentChunks for
 * incremental writes across long-running extraction pipelines.
 */
export async function createDocumentRecord(params: {
  serverId: number;
  personaId: number | null;
  uploaderUserId: number | null;
  documentName: string;
  sourceType?: string;
  channelTags?: string[];
}): Promise<number> {
  const { serverId, personaId, uploaderUserId, documentName, sourceType = "upload", channelTags = [] } = params;
  const [row] = await sql`
    INSERT INTO documents (
      server_id, persona_id, uploader_user_id, document_name,
      file_name, mime_type, file_size_bytes, text_content, source_type, channel_tags
    ) VALUES (
      ${serverId}, ${personaId}, ${uploaderUserId}, ${documentName},
      NULL, NULL, NULL, '', ${sourceType}, ${toPgTextArray(channelTags)}::text[]
    )
    RETURNING document_id
  `;
  if (!row?.document_id) throw new Error("Failed to insert document row");
  return Number(row.document_id);
}

/**
 * Appends a batch of chunks (with embeddings) to an existing document starting
 * at the given chunk index.
 */
export async function appendDocumentChunks(params: {
  documentId: number;
  serverId: number;
  embeddingModelId: number;
  embeddingFamily: string;
  startIndex: number;
  chunks: string[];
  embeddings: number[][];
}): Promise<void> {
  const { documentId, serverId, embeddingModelId, embeddingFamily, startIndex, chunks, embeddings } = params;
  if (chunks.length !== embeddings.length) {
    throw new Error(`Chunk/embedding count mismatch: ${chunks.length} vs ${embeddings.length}`);
  }
  await sql.transaction(async (tx) => {
    for (let i = 0; i < chunks.length; i++) {
      const embeddingVector = formatVector(embeddings[i]);
      await tx`
        INSERT INTO document_chunks (
          document_id, server_id, embedding_model_id, embedding_family,
          chunk_index, content, embedding
        ) VALUES (
          ${documentId}, ${serverId}, ${embeddingModelId}, ${embeddingFamily},
          ${startIndex + i}, ${chunks[i]}, ${embeddingVector}::vector
        )
      `;
    }
  });
}

/**
 * Sets the text_content column on a document after all chunks have been appended.
 * Required for reembedServerDocuments to work correctly on history imports.
 */
export async function finalizeDocumentContent(documentId: number, textContent: string): Promise<void> {
  await sql`UPDATE documents SET text_content = ${textContent} WHERE document_id = ${documentId}`;
}

/**
 * Rebuilds a document's text_content column from its current chunks (ordered by
 * chunk_index, joined by blank lines). Call this after any edit/delete that
 * mutates chunk content so reembedServerDocuments stays consistent with the
 * stored chunk set.
 */
export async function rebuildDocumentTextContent(documentId: number): Promise<void> {
  const rows = await sql<Array<{ content: string }>>`
    SELECT content
    FROM document_chunks
    WHERE document_id = ${documentId}
    ORDER BY chunk_index ASC
  `;
  const joined = rows.map((r) => r.content).join("\n\n");
  await sql`UPDATE documents SET text_content = ${joined} WHERE document_id = ${documentId}`;
}

export async function insertDocumentWithChunks(params: {
  serverId: number;
  personaId: number | null;
  uploaderUserId: number | null;
  documentName: string;
  fileName: string | null;
  mimeType: string | null;
  fileSizeBytes: number | null;
  textContent: string;
  chunks: string[];
  embeddings: number[][];
  embeddingModelId: number;
  embeddingFamily: string;
  /** Document origin: 'upload' (default) or 'history' */
  sourceType?: string;
  /** Channel tags restricting retrieval to specific channels, e.g. ['#general', '#bot-chat'] */
  channelTags?: string[];
}): Promise<number> {
  const {
    serverId,
    personaId,
    uploaderUserId,
    documentName,
    fileName,
    mimeType,
    fileSizeBytes,
    textContent,
    chunks,
    embeddings,
    embeddingModelId,
    embeddingFamily,
    sourceType = "upload",
    channelTags = [],
  } = params;

  if (chunks.length !== embeddings.length) {
    throw new Error(`Chunk count (${chunks.length}) does not match embedding count (${embeddings.length})`);
  }

  return sql.transaction(async (tx) => {
    const [documentRow] = await tx`
			INSERT INTO documents (
				server_id,
				persona_id,
				uploader_user_id,
				document_name,
				file_name,
				mime_type,
				file_size_bytes,
				text_content,
				source_type,
				channel_tags
			) VALUES (
				${serverId},
				${personaId},
				${uploaderUserId},
				${documentName},
				${fileName},
				${mimeType},
				${fileSizeBytes},
				${textContent},
				${sourceType},
				${toPgTextArray(channelTags)}::text[]
			)
			RETURNING document_id
		`;

    if (!documentRow?.document_id) {
      throw new Error("Failed to insert document row");
    }

    const documentId = Number(documentRow.document_id);

    for (let i = 0; i < chunks.length; i += 1) {
      const embeddingVector = formatVector(embeddings[i]);
      await tx`
				INSERT INTO document_chunks (
					document_id,
					server_id,
					embedding_model_id,
					embedding_family,
					chunk_index,
					content,
					embedding
				) VALUES (
					${documentId},
					${serverId},
					${embeddingModelId},
					${embeddingFamily},
					${i},
					${chunks[i]},
					${embeddingVector}::vector
				)
			`;
    }

    return documentId;
  });
}

export interface WeightedQuery {
  text: string;
  weight: number;
}

/**
 * Retrieves candidate chunks for a single query lane: hybrid vector + full-text
 * search merged via intra-lane Reciprocal Rank Fusion (k=60), then filtered by
 * minSimilarity with an FTS bypass (verbose chunks have dilute centroids that
 * under-rate contextual queries, so a lexical match is trusted over the cosine floor).
 */
async function retrieveLaneChunks(params: {
  serverId: number;
  personaId?: number | null;
  queryText: string;
  queryVector: string;
  embeddingModel: EmbeddingModelRow;
  candidateLimit: number;
  minSimilarity: number;
  channelName?: string | null;
}): Promise<RetrievedDocumentChunk[]> {
  const { serverId, personaId, queryText, queryVector, embeddingModel, candidateLimit, minSimilarity, channelName } =
    params;

  const channelFilter =
    channelName != null
      ? sql`AND (array_length(d.channel_tags, 1) IS NULL OR ${`#${channelName.toLowerCase()}`} = ANY(d.channel_tags))`
      : sql``;

  const personaFilter =
    personaId === null || personaId === undefined
      ? sql`AND d.persona_id IS NULL`
      : sql`AND (d.persona_id = ${personaId} OR d.persona_id IS NULL)`;

  const rows = await sql<
    Array<{
      document_id: number;
      document_name: string;
      chunk_index: number;
      content: string;
      distance: number | string;
      fts_rank: number | string | null;
    }>
  >`
    WITH fts_q AS (
      SELECT plainto_tsquery('english', ${queryText}::text) AS q
    ),
    vector_candidates AS (
      SELECT dc.document_chunk_id,
             ROW_NUMBER() OVER (ORDER BY dc.embedding <=> ${queryVector}::vector) AS rnk
      FROM document_chunks dc
      JOIN documents d ON d.document_id = dc.document_id
      WHERE dc.server_id = ${serverId}
        AND dc.embedding_family = ${embeddingModel.model_family}
        ${personaFilter}
        ${channelFilter}
      ORDER BY dc.embedding <=> ${queryVector}::vector
      LIMIT ${candidateLimit}
    ),
    fts_candidates AS (
      SELECT dc.document_chunk_id,
             ROW_NUMBER() OVER (ORDER BY ts_rank(dc.tsv, fts_q.q) DESC) AS rnk
      FROM document_chunks dc
      JOIN documents d ON d.document_id = dc.document_id
      CROSS JOIN fts_q
      WHERE dc.server_id = ${serverId}
        AND dc.embedding_family = ${embeddingModel.model_family}
        ${personaFilter}
        ${channelFilter}
        AND dc.tsv IS NOT NULL
        AND fts_q.q::text != ''
        AND dc.tsv @@ fts_q.q
      ORDER BY ts_rank(dc.tsv, fts_q.q) DESC
      LIMIT ${candidateLimit}
    ),
    rrf_merged AS (
      SELECT document_chunk_id,
             SUM(1.0 / (60.0 + rnk)) AS rrf_score,
             MIN(CASE WHEN src = 'fts' THEN rnk END) AS fts_rank
      FROM (
        SELECT document_chunk_id, rnk, 'vec'::text AS src FROM vector_candidates
        UNION ALL
        SELECT document_chunk_id, rnk, 'fts'::text AS src FROM fts_candidates
      ) combined
      GROUP BY document_chunk_id
    )
    SELECT dc.document_id, d.document_name, dc.chunk_index, dc.content,
           (dc.embedding <=> ${queryVector}::vector) AS distance,
           r.fts_rank
    FROM rrf_merged r
    JOIN document_chunks dc ON dc.document_chunk_id = r.document_chunk_id
    JOIN documents d ON d.document_id = dc.document_id
    ORDER BY r.rrf_score DESC
    LIMIT ${candidateLimit}
  `;

  const results: RetrievedDocumentChunk[] = [];
  for (const row of rows) {
    const distance = typeof row.distance === "string" ? Number.parseFloat(row.distance) : Number(row.distance);
    const similarity = Number.isFinite(distance) ? 1 - distance : 0;
    const ftsMatched = row.fts_rank != null;
    if (similarity < minSimilarity && !ftsMatched) {
      continue;
    }
    results.push({
      document_id: row.document_id,
      document_name: row.document_name,
      chunk_index: row.chunk_index,
      content: row.content,
      similarity,
    });
  }

  return results;
}

const LANE_FUSION_K = 60;

export async function retrieveRelevantDocumentChunks(params: {
  serverId: number;
  personaId?: number | null;
  /** Weighted query lanes (e.g. combined/user/memory). Empty-text or non-positive-weight lanes are skipped. */
  queries: WeightedQuery[];
  embeddingModel: EmbeddingModelRow;
  apiKey: string;
  maxResults: number;
  minSimilarity: number;
  batchSize?: number;
  /** When set, excludes chunks whose document has channel_tags that don't include this channel */
  channelName?: string | null;
}): Promise<RetrievedDocumentChunk[]> {
  const { serverId, personaId, queries, embeddingModel, apiKey, maxResults, minSimilarity, batchSize, channelName } =
    params;

  const activeQueries = queries.filter((q) => q.text.trim().length > 0 && q.weight > 0);
  if (activeQueries.length === 0) {
    return [];
  }

  const queryEmbeddings = await generateEmbeddingsBatched({
    provider: embeddingModel.provider,
    apiKey,
    model: embeddingModel.codename,
    modelId: embeddingModel.embedding_model_id,
    inputs: activeQueries.map((q) => q.text),
    taskType: (await providerSupportsEmbeddingTaskType(embeddingModel.provider)) ? "RETRIEVAL_QUERY" : undefined,
    batchSize,
  });

  if (queryEmbeddings.length !== activeQueries.length) {
    return [];
  }

  // Cast a wide net so RRF has enough candidates from each ranked list to merge well.
  const candidateLimit = maxResults * 4;

  const laneResultSets = await Promise.all(
    activeQueries.map((laneQuery, idx) =>
      retrieveLaneChunks({
        serverId,
        personaId,
        queryText: laneQuery.text,
        queryVector: formatVector(queryEmbeddings[idx]),
        embeddingModel,
        candidateLimit,
        minSimilarity,
        channelName,
      }),
    ),
  );

  // Inter-lane weighted RRF: score = Σ w_lane × 1/(k + rank_i), where rank_i is the
  // chunk's position within lane i's already minSimilarity-filtered, intra-lane-fused
  // list. Uniformly scaling weights (e.g. when a lane is dropped) never changes the
  // resulting order, so no explicit renormalization is needed here.
  const fused = new Map<
    string,
    { weightedScore: number; bestSimilarity: number; chunk: Omit<RetrievedDocumentChunk, "similarity"> }
  >();
  laneResultSets.forEach((laneResults, idx) => {
    const weight = activeQueries[idx].weight;
    laneResults.forEach((chunk, rankIndex) => {
      const contribution = weight * (1 / (LANE_FUSION_K + rankIndex + 1));
      const key = `${chunk.document_id}:${chunk.chunk_index}`;
      const existing = fused.get(key);
      if (existing) {
        existing.weightedScore += contribution;
        existing.bestSimilarity = Math.max(existing.bestSimilarity, chunk.similarity);
      } else {
        fused.set(key, {
          weightedScore: contribution,
          bestSimilarity: chunk.similarity,
          chunk: {
            document_id: chunk.document_id,
            document_name: chunk.document_name,
            chunk_index: chunk.chunk_index,
            content: chunk.content,
          },
        });
      }
    });
  });

  return Array.from(fused.values())
    .sort((a, b) => b.weightedScore - a.weightedScore)
    .slice(0, maxResults)
    .map((entry) => ({ ...entry.chunk, similarity: entry.bestSimilarity }));
}

export function formatRetrievedChunksForPrompt(chunks: RetrievedDocumentChunk[]): string | null {
  if (!chunks.length) {
    return null;
  }

  let output = "[System: The following are relevant excerpts from server documents:\n\n";
  let currentDoc = "";

  for (const chunk of chunks) {
    if (chunk.document_name !== currentDoc) {
      output += `${currentDoc ? "\n" : ""}${chunk.document_name}:\n`;
      currentDoc = chunk.document_name;
    }
    output += `${chunk.content}\n`;
  }

  const trimmed = output.trim();
  return trimmed.length > 0 ? `${trimmed}]` : null;
}

export async function reembedServerDocuments(params: {
  serverId: number;
  embeddingModel: EmbeddingModelRow;
  apiKey: string;
  chunkSize: number;
  chunkOverlap: number;
}): Promise<void> {
  const { serverId, embeddingModel, apiKey, chunkSize, chunkOverlap } = params;

  if (!embeddingModel.embedding_model_id) {
    throw new Error("Embedding model ID is missing for re-embedding");
  }

  const documents = await sql<
    Array<{
      document_id: number;
      text_content: string;
    }>
  >`
		SELECT document_id, text_content
		FROM documents
		WHERE server_id = ${serverId}
		ORDER BY document_id ASC
	`;

  for (const document of documents) {
    const normalized = normalizeDocumentText(document.text_content);
    const chunks = chunkDocumentText(normalized, chunkSize, chunkOverlap);

    if (chunks.length === 0) {
      log.warn(`Skipping empty document during re-embed: ${document.document_id}`);
      continue;
    }

    const embeddings = await generateEmbeddingsBatched({
      provider: embeddingModel.provider,
      apiKey,
      model: embeddingModel.codename,
      modelId: embeddingModel.embedding_model_id,
      inputs: chunks,
      taskType: (await providerSupportsEmbeddingTaskType(embeddingModel.provider)) ? "RETRIEVAL_DOCUMENT" : undefined,
      batchSize: 16,
    });

    await sql.transaction(async (tx) => {
      await tx`
				DELETE FROM document_chunks
				WHERE document_id = ${document.document_id}
			`;

      for (let i = 0; i < chunks.length; i += 1) {
        const embeddingVector = formatVector(embeddings[i]);
        await tx`
					INSERT INTO document_chunks (
						document_id,
						server_id,
					embedding_model_id,
					embedding_family,
					chunk_index,
					content,
					embedding
				) VALUES (
					${document.document_id},
					${serverId},
					${embeddingModel.embedding_model_id},
					${embeddingModel.model_family},
					${i},
					${chunks[i]},
					${embeddingVector}::vector
				)
				`;
      }
    });
  }
}
