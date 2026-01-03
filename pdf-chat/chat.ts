/**
 * Chat Interface Example
 * 
 * This script provides an interactive chat interface to query
 * the knowledge graph built from uploaded PDF documents.
 * 
 * Usage: pnpm chat
 */

import {
  createHanaConnection,
  HanaPropertyGraphStore,
  PropertyGraphIndex,
  ImplicitPathExtractor,
  KG_SOURCE_REL,
} from "hana-kgvector";
import OpenAI from "openai";
import dotenv from "dotenv";
import * as readline from "readline";

dotenv.config({ path: ".env.local" });

// Configuration
const GRAPH_NAME = "pdf_documents";
const EMBEDDING_MODEL = process.env.DEFAULT_EMBEDDING_MODEL || "text-embedding-3-small";

let AUTO_EXPLAIN = false;

const DEFAULT_QUERY_OPTIONS = {
  similarityTopK: 5,
  pathDepth: 2,
  limit: 30,
  crossCheckBoost: true,
  crossCheckBoostFactor: 1.25,
};

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.LITELLM_API_KEY,
  baseURL: process.env.LITELLM_PROXY_URL,
});

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Embedding model wrapper
const embedModel = {
  async getTextEmbedding(text: string): Promise<number[]> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await openai.embeddings.create({
          model: EMBEDDING_MODEL,
          input: text,
          encoding_format: "float",
        });

        const rawEmbedding = response.data[0].embedding as unknown;
        let embedding: number[];

        // Prefer numeric embeddings to avoid any base64/proxy decoding mismatch.
        if (Array.isArray(rawEmbedding)) {
          embedding = rawEmbedding as number[];
        } else if (typeof rawEmbedding === "string") {
          const buffer = Buffer.from(rawEmbedding, "base64");
          if (buffer.byteLength % 4 !== 0) {
            throw new Error(
              `Invalid base64 embedding byteLength=${buffer.byteLength} (not divisible by 4)`
            );
          }
          const float32Array = new Float32Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength / 4
          );
          embedding = Array.from(float32Array);
        } else {
          throw new Error("Unknown embedding format returned by provider");
        }

        const hasInvalidValues = embedding.some((v) => v === null || !Number.isFinite(v));
        if (hasInvalidValues) {
          throw new Error("Embedding contains invalid values (null/NaN/Infinity)");
        }

        const maxAbs = embedding.reduce((m, v) => Math.max(m, Math.abs(v as number)), 0);
        if (maxAbs > 100) {
          throw new Error("Embedding magnitude too large; likely decode/format mismatch");
        }

        return embedding;
      } catch (error: any) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * attempt;
          console.log(`   [Embed] ⚠️ Retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
          await sleep(delay);
        }
      }
    }

    throw lastError;
  },
  
  async getTextEmbeddingBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.getTextEmbedding(t)));
  },
};

function shouldDropContextLine(line: string): boolean {
  const t = (line ?? "").toLowerCase();
  if (!t) return true;
  return (
    t.includes("urn:hkv:prop:") ||
    t.includes("rdf-syntax-ns#type") ||
    t.includes("triplet_source_id") ||
    t.includes("documentid") ||
    t.includes("from_document")
  );
}

function sanitizeContextText(text: string): string {
  // The retriever often returns a combined string:
  //  - preamble
  //  - KG triplets (some noisy metadata)
  //  - original chunk text
  // We want to keep semantic triplets + chunk text, but drop metadata lines.
  const lines = (text ?? "").split("\n");
  const kept = lines.filter((l) => !shouldDropContextLine(l));
  return kept.join("\n").trim();
}

/**
 * Generate AI response using retrieved context
 */
async function generateResponse(query: string, results: any[]): Promise<string> {
  if (results.length === 0) {
    return "I don't have enough information in the uploaded documents to answer that question.";
  }
  
  const contextResults = results.slice(0, 8);

  // Build context from selected results
  const context = contextResults
    .map((r, i) => {
      const raw = String(r?.node?.text ?? "");
      const cleaned = sanitizeContextText(raw);
      return `[${i + 1}] ${cleaned}`;
    })
    .join("\n\n");
  
  const systemPrompt = `You are a helpful assistant that answers questions based only on the provided document context.
If the user asks for a list of "options", "types", or "ways", enumerate ALL options that appear in the context.
Do not omit options that are present.
If an option is not present in the context, say it is not present.`;
  
  const userPrompt = `Context from documents:
${context}

Question: ${query}

Answer:`;
  
  const response = await openai.chat.completions.create({
    model: process.env.DEFAULT_LLM_MODEL || "gpt-4",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
  });
  
  return response.choices[0]?.message?.content || "Unable to generate response.";
}

async function explainRetrieval(
  query: string,
  graphStore: any,
  options: typeof DEFAULT_QUERY_OPTIONS
): Promise<void> {
  console.log("\n🧪 Explain KG-RAG (debug)");
  console.log(`   Query: ${query}`);
  console.log(`   Embedding model: ${EMBEDDING_MODEL}`);
  console.log(
    `   Options: similarityTopK=${options.similarityTopK}, pathDepth=${options.pathDepth}, limit=${options.limit}, crossCheckBoost=${options.crossCheckBoost}, crossCheckBoostFactor=${options.crossCheckBoostFactor}`
  );

  const embedding = await embedModel.getTextEmbedding(query);
  console.log(`   Query embedding dim: ${embedding.length}`);

  const [kgNodes, scores] = await graphStore.vectorQuery({
    queryEmbedding: embedding,
    similarityTopK: options.similarityTopK,
  });

  console.log(`\n🔎 Vector-matched KG nodes (top ${options.similarityTopK}):`);
  if (!kgNodes || kgNodes.length === 0) {
    console.log("   (none)");
    return;
  }
  kgNodes.forEach((n: any, i: number) => {
    const s = scores?.[i];
    const label = n?.label ?? "?";
    const name = n?.name ?? n?.id ?? "?";
    const docId = n?.properties?.documentId;
    const sourceChunk = n?.properties?.sourceChunk;
    console.log(
      `   [${i + 1}] score=${typeof s === "number" ? s.toFixed(6) : "N/A"} label=${label} name=${name} docId=${docId ?? "-"} sourceChunk=${sourceChunk ?? "-"}`
    );
  });

  const provenanceSet = new Set<string>();
  if (options.crossCheckBoost) {
    for (const node of kgNodes) {
      if (node?.id) provenanceSet.add(String(node.id).toLowerCase());
      if (node?.name) provenanceSet.add(String(node.name).toLowerCase());
      const props = node?.properties ?? {};
      if (props.documentId) provenanceSet.add(String(props.documentId).toLowerCase());
      if (props.sourceChunk) provenanceSet.add(String(props.sourceChunk).toLowerCase());
    }
  }

  const triplets = await graphStore.getRelMap({
    nodes: kgNodes,
    depth: options.pathDepth,
    limit: options.limit,
    ignoreRels: [KG_SOURCE_REL],
  });

  const isMetadataPredicate = (pred: string) => {
    if (!pred) return true;
    if (pred.includes("urn:hkv:prop:")) return true;
    if (pred === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type") return true;
    if (pred === "FROM_DOCUMENT") return true;
    return false;
  };

  const split = (triplets as any[]).reduce(
    (acc, t) => {
      const p = t?.[1]?.label ?? t?.[1]?.id ?? "";
      if (isMetadataPredicate(String(p))) acc.metadata.push(t);
      else acc.semantic.push(t);
      return acc;
    },
    { semantic: [] as any[], metadata: [] as any[] }
  );

  console.log(
    `\n🧭 Expanded triplets (depth=${options.pathDepth}, limit=${options.limit}): total=${triplets.length} semantic=${split.semantic.length} metadata=${split.metadata.length}`
  );
  const kgIds = kgNodes.map((n: any) => n.id);
  const scoredTriplets = (split.semantic.length > 0 ? split.semantic : (triplets as any[])).map((t: any) => {
    const idx1 = kgIds.indexOf(t[0]?.id);
    const idx2 = kgIds.indexOf(t[2]?.id);
    const score1 = idx1 >= 0 ? scores[idx1] : 0;
    const score2 = idx2 >= 0 ? scores[idx2] : 0;
    const base = Math.max(score1 ?? 0, score2 ?? 0);

    let boosted = base;
    let boostedReason: string | null = null;
    if (options.crossCheckBoost && boosted > 0) {
      const s = t[0];
      const o = t[2];
      const shouldBoost =
        (s?.properties?.documentId && provenanceSet.has(String(s.properties.documentId).toLowerCase())) ||
        (s?.properties?.sourceChunk && provenanceSet.has(String(s.properties.sourceChunk).toLowerCase())) ||
        (o?.properties?.documentId && provenanceSet.has(String(o.properties.documentId).toLowerCase())) ||
        (o?.properties?.sourceChunk && provenanceSet.has(String(o.properties.sourceChunk).toLowerCase())) ||
        (s?.id && provenanceSet.has(String(s.id).toLowerCase())) ||
        (s?.name && provenanceSet.has(String(s.name).toLowerCase())) ||
        (o?.id && provenanceSet.has(String(o.id).toLowerCase())) ||
        (o?.name && provenanceSet.has(String(o.name).toLowerCase()));

      if (shouldBoost) {
        boosted = Math.min(1, boosted * options.crossCheckBoostFactor);
        boostedReason = "provenance match";
      }
    }

    return { triplet: t, baseScore: base, score: boosted, boostedReason };
  });

  scoredTriplets.sort((a: { score: number }, b: { score: number }) => b.score - a.score);
  for (const [i, r] of scoredTriplets.slice(0, 20).entries()) {
    const [s, p, o] = r.triplet;
    const subj = `${s?.label ?? "?"}:${s?.name ?? s?.id ?? "?"}`;
    const pred = p?.label ?? p?.id ?? "?";
    const obj = `${o?.label ?? "?"}:${o?.name ?? o?.id ?? "?"}`;
    const boostNote = r.boostedReason ? ` boosted(${r.boostedReason})` : "";
    console.log(
      `   [${i + 1}] score=${r.score.toFixed(6)} base=${r.baseScore.toFixed(6)}${boostNote} :: ${subj} -[${pred}]-> ${obj}`
    );
  }
  console.log();
}

async function main() {
  console.log("=".repeat(70));
  console.log("  PDF Chat Interface - Query Your Documents");
  console.log("=".repeat(70));
  
  // Connect to HANA
  console.log("\n🔌 Connecting to HANA Cloud...");
  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    port: parseInt(process.env.HANA_PORT || "443"),
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });
  console.log("   ✅ Connected");
  
  // Initialize graph store and index
  console.log(`\n🗄️  Loading knowledge graph (graph: ${GRAPH_NAME})`);
  const graphStore = new HanaPropertyGraphStore(conn, {
    graphName: GRAPH_NAME,
  });
  
  const index = new PropertyGraphIndex({
    propertyGraphStore: graphStore,
    embedModel,
    kgExtractors: [new ImplicitPathExtractor()],
    embedKgNodes: false, // Don't embed on query, only on insert
  });
  
  console.log("   ✅ Ready");
  
  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  console.log("\n" + "=".repeat(70));
  console.log("💬 Chat started! Ask questions about your uploaded documents.");
  console.log("   Commands: 'exit' or 'quit' to exit, 'help' for options");
  console.log("=".repeat(70) + "\n");

  let lastQuestion: string | null = null;
  
  // Chat loop
  const askQuestion = () => {
    rl.question("You: ", async (input) => {
      const query = input.trim();
      const queryLower = query.toLowerCase();
      
      if (!query) {
        askQuestion();
        return;
      }
      
      // Handle commands
      if (queryLower === "exit" || queryLower === "quit") {
        console.log("\n👋 Goodbye!\n");
        rl.close();
        process.exit(0);
        return;
      }
      
      if (queryLower === "help") {
        console.log("\n📖 Available commands:");
        console.log("   - Ask any question about your documents");
        console.log("   - 'exit' or 'quit' - Exit the chat");
        console.log("   - 'help' - Show this help message");
        console.log("   - 'explain <question>' - Show KG-RAG retrieval internals for a question");
        console.log("   - 'explain-last' - Explain the previous question\n");
        console.log("   - 'auto-explain' - Toggle showing KG-RAG debug for every question\n");
        askQuestion();
        return;
      }

      if (queryLower === "auto-explain") {
        AUTO_EXPLAIN = !AUTO_EXPLAIN;
        console.log(`\n🔧 Auto-explain: ${AUTO_EXPLAIN ? "ON" : "OFF"}\n`);
        askQuestion();
        return;
      }

      if (queryLower === "explain-last") {
        if (!lastQuestion) {
          console.log("\nNo previous question to explain yet.\n");
          askQuestion();
          return;
        }
        try {
          await explainRetrieval(lastQuestion, graphStore, DEFAULT_QUERY_OPTIONS);
          console.log("🤖 Assistant: ");
          const results = await index.query(lastQuestion, DEFAULT_QUERY_OPTIONS);
          const response = await generateResponse(lastQuestion, results);
          console.log(response);
        } catch (error: any) {
          console.error("\n❌ Explain error:", error.message);
        }
        askQuestion();
        return;
      }

      if (queryLower.startsWith("explain ")) {
        const explainQuery = query.slice("explain ".length).trim();
        if (!explainQuery) {
          console.log("\nUsage: explain <your question>\n");
          askQuestion();
          return;
        }
        try {
          await explainRetrieval(explainQuery, graphStore, DEFAULT_QUERY_OPTIONS);
          console.log("🤖 Assistant: ");
          const results = await index.query(explainQuery, DEFAULT_QUERY_OPTIONS);
          const response = await generateResponse(explainQuery, results);
          console.log(response);
        } catch (error: any) {
          console.error("\n❌ Explain error:", error.message);
        }
        askQuestion();
        return;
      }
      
      try {
        // Query the knowledge graph
        console.log("\n🔍 Searching...");

        lastQuestion = query;

        if (AUTO_EXPLAIN) {
          await explainRetrieval(query, graphStore, DEFAULT_QUERY_OPTIONS);
        }
        
        const results = await index.query(query, DEFAULT_QUERY_OPTIONS);
        
        console.log(`   Found ${results.length} relevant passages\n`);
        
        // Generate AI response
        console.log("🤖 Assistant: ");
        const response = await generateResponse(query, results);
        console.log(response);
        
        // Show sources
        if (results.length > 0) {
          console.log("\n📚 Sources:");
          const uniqueDocs = new Set(
            results.map((r) => r.node.metadata?.documentId).filter(Boolean)
          );
          uniqueDocs.forEach((doc) => console.log(`   - ${doc}`));
        }
        
        console.log();
      } catch (error: any) {
        console.error("\n❌ Error:", error.message);
        console.log();
      }
      
      askQuestion();
    });
  };
  
  askQuestion();
}

main().catch((error) => {
  console.error("\n❌ Error:", error.message);
  process.exit(1);
});
