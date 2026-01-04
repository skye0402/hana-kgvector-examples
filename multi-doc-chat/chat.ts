/**
 * Multi-Document Chat Interface
 * 
 * This script provides an interactive chat interface to query
 * across multiple documents in the knowledge graph.
 * 
 * Features:
 * - Query across all documents
 * - Filter by specific document(s)
 * - See which documents contributed to the answer
 * 
 * Usage: pnpm chat
 */

import {
  createHanaConnection,
  HanaPropertyGraphStore,
  PropertyGraphIndex,
  ImplicitPathExtractor,
} from "hana-kgvector";
import OpenAI from "openai";
import dotenv from "dotenv";
import * as readline from "readline";

dotenv.config({ path: ".env.local" });

// Configuration
const GRAPH_NAME = "multi_doc_graph";
const EMBEDDING_MODEL = process.env.DEFAULT_EMBEDDING_MODEL || "text-embedding-3-small";

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
        if (Array.isArray(rawEmbedding)) {
          return rawEmbedding as number[];
        } else if (typeof rawEmbedding === "string") {
          const buffer = Buffer.from(rawEmbedding, "base64");
          const float32Array = new Float32Array(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength / 4
          );
          return Array.from(float32Array);
        }
        throw new Error("Unknown embedding format");
      } catch (error: any) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }
    throw lastError;
  },
  
  async getTextEmbeddingBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.getTextEmbedding(t)));
  },
};

// Document filter state
let documentFilter: string[] = [];

// Store connection for direct queries
let hanaConn: any = null;

/**
 * Direct vector search on GRAPH_NODES table (source chunks)
 * This finds content that may not have produced KG entities (like image descriptions)
 */
async function directSourceChunkSearch(
  queryEmbedding: number[],
  topK: number = 10
): Promise<any[]> {
  if (!hanaConn) return [];
  
  const nodesTable = `"${GRAPH_NAME}_NODES"`;
  const sql = `
    SELECT ID, TEXT, METADATA,
      COSINE_SIMILARITY(EMBEDDING, TO_REAL_VECTOR(?)) AS SCORE
    FROM ${nodesTable}
    WHERE EMBEDDING IS NOT NULL
    ORDER BY SCORE DESC
    LIMIT ?
  `;
  
  try {
    const rows = await new Promise<any[]>((resolve, reject) => {
      hanaConn.exec(sql, [JSON.stringify(queryEmbedding), topK], (err: any, result: any) => {
        if (err) reject(err);
        else resolve(result ?? []);
      });
    });
    
    return rows.map((r: any) => ({
      node: {
        id: r.ID,
        text: r.TEXT,
        metadata: JSON.parse(r.METADATA || "{}"),
      },
      score: r.SCORE,
    }));
  } catch (error) {
    // Table might not exist or other error - fall back gracefully
    return [];
  }
}

/**
 * Merge and deduplicate results from KG retrieval and direct chunk search
 */
function mergeResults(kgResults: any[], chunkResults: any[]): any[] {
  const seen = new Set<string>();
  const merged: any[] = [];
  
  // Add KG results first (they have graph context)
  for (const r of kgResults) {
    const key = r.node?.text?.slice(0, 200) || r.node?.id;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(r);
    }
  }
  
  // Add chunk results that aren't duplicates
  for (const r of chunkResults) {
    const key = r.node?.text?.slice(0, 200) || r.node?.id;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(r);
    }
  }
  
  // Sort by score descending
  merged.sort((a, b) => (b.score || 0) - (a.score || 0));
  
  return merged;
}

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
  const lines = (text ?? "").split("\n");
  const kept = lines.filter((l) => !shouldDropContextLine(l));
  return kept.join("\n").trim();
}

function getResultDocumentId(result: any): string | null {
  const md = result?.node?.metadata;
  const docId =
    md?.documentId ??
    md?.from_document ??
    md?.fromDocument ??
    md?.docId ??
    md?.document;

  if (typeof docId !== "string") return null;
  const trimmed = docId.trim();
  return trimmed ? trimmed : null;
}

/**
 * Generate AI response using retrieved context
 */
async function generateResponse(
  query: string, 
  results: any[],
  documentSources: Map<string, number>
): Promise<string> {
  if (results.length === 0) {
    return "I don't have enough information in the uploaded documents to answer that question.";
  }
  
  const contextResults = results.slice(0, 8);

  // Build context with document and content type attribution
  const context = contextResults
    .map((r, i) => {
      const raw = String(r?.node?.text ?? "");
      const cleaned = sanitizeContextText(raw);
      const docId = getResultDocumentId(r) ?? "graph";
      const contentType = r?.node?.metadata?.contentType || "text";
      const pageNum = r?.node?.metadata?.pageNumber;
      
      // Format source info
      let sourceInfo = `from: ${docId}`;
      if (pageNum) sourceInfo += `, page ${pageNum}`;
      if (contentType === "image") sourceInfo += ", [IMAGE DESCRIPTION]";
      
      return `[${i + 1}] (${sourceInfo})\n${cleaned}`;
    })
    .join("\n\n");
  
  // Count image vs text sources
  const imageCount = contextResults.filter(r => r?.node?.metadata?.contentType === "image").length;
  const textCount = contextResults.length - imageCount;
  
  // Build source summary
  const sourceList = Array.from(documentSources.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([doc, count]) => `${doc} (${count} passages)`)
    .join(", ");
  
  const systemPrompt = `You are a helpful assistant that answers questions based on the provided document context.
The context comes from MULTIPLE documents and may include both text passages and IMAGE DESCRIPTIONS.
When answering:
1. Synthesize information from all relevant documents
2. If documents have conflicting information, mention both perspectives
3. Cite which document(s) support each part of your answer when relevant
4. If information comes from an image description, mention that (e.g., "According to the diagram...")
5. If the answer is only in one document, mention that

Documents in context: ${sourceList}
Context includes: ${textCount} text passages, ${imageCount} image descriptions`;
  
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

/**
 * Filter results by document
 */
function filterResultsByDocument(results: any[], filter: string[]): any[] {
  if (filter.length === 0) return results;
  
  return results.filter(r => {
    const docId = r?.node?.metadata?.documentId;
    if (!docId) return false;
    return filter.some(f => docId.toLowerCase().includes(f.toLowerCase()));
  });
}

/**
 * Get document sources from results
 */
function getDocumentSources(results: any[]): Map<string, number> {
  const sources = new Map<string, number>();
  for (const r of results) {
    const docId = getResultDocumentId(r);
    if (!docId) continue;
    sources.set(docId, (sources.get(docId) || 0) + 1);
  }
  return sources;
}

async function main() {
  console.log("=".repeat(70));
  console.log("  Multi-Document Chat - Query Across Your Documents");
  console.log("=".repeat(70));
  
  // Connect to HANA
  console.log("\n🔌 Connecting to HANA Cloud...");
  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    port: parseInt(process.env.HANA_PORT || "443"),
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });
  hanaConn = conn; // Store for direct queries
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
    embedKgNodes: false,
  });
  
  console.log("   ✅ Ready");
  
  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  console.log("\n" + "=".repeat(70));
  console.log("💬 Chat started! Ask questions across your uploaded documents.");
  console.log("   Commands:");
  console.log("   • 'filter <doc1> <doc2>' - Filter to specific documents");
  console.log("   • 'filter clear' - Clear filter (query all documents)");
  console.log("   • 'filter' - Show current filter");
  console.log("   • 'sources' - Show document sources from last query");
  console.log("   • 'help' - Show all commands");
  console.log("   • 'exit' - Exit the chat");
  console.log("=".repeat(70) + "\n");

  let lastSources: Map<string, number> = new Map();
  
  // Chat loop
  const askQuestion = () => {
    const filterStatus = documentFilter.length > 0 
      ? ` [filter: ${documentFilter.join(", ")}]` 
      : "";
    
    rl.question(`You${filterStatus}: `, async (input) => {
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
        console.log("   • Ask any question about your documents");
        console.log("   • 'filter <doc1> <doc2>' - Filter to specific documents");
        console.log("   • 'filter clear' - Clear filter (query all documents)");
        console.log("   • 'filter' - Show current filter");
        console.log("   • 'sources' - Show document sources from last query");
        console.log("   • 'compare <topic>' - Compare how documents discuss a topic");
        console.log("   • 'exit' or 'quit' - Exit the chat\n");
        askQuestion();
        return;
      }
      
      if (queryLower === "filter") {
        if (documentFilter.length === 0) {
          console.log("\n📋 No filter active - querying all documents\n");
        } else {
          console.log(`\n📋 Current filter: ${documentFilter.join(", ")}\n`);
        }
        askQuestion();
        return;
      }
      
      if (queryLower === "filter clear") {
        documentFilter = [];
        console.log("\n✅ Filter cleared - now querying all documents\n");
        askQuestion();
        return;
      }
      
      if (queryLower.startsWith("filter ")) {
        const docs = query.slice(7).trim().split(/\s+/);
        if (docs.length > 0 && docs[0]) {
          documentFilter = docs;
          console.log(`\n✅ Filter set to: ${documentFilter.join(", ")}\n`);
        }
        askQuestion();
        return;
      }
      
      if (queryLower === "sources") {
        if (lastSources.size === 0) {
          console.log("\n📚 No sources yet - ask a question first\n");
        } else {
          console.log("\n📚 Document sources from last query:");
          for (const [doc, count] of lastSources.entries()) {
            console.log(`   • ${doc}: ${count} passages`);
          }
          console.log();
        }
        askQuestion();
        return;
      }
      
      // Handle compare command
      if (queryLower.startsWith("compare ")) {
        const topic = query.slice(8).trim();
        const compareQuery = `Compare and contrast how the different documents discuss: ${topic}. Note any differences in perspective, detail, or focus between documents.`;
        
        try {
          console.log("\n🔍 Comparing across documents...");
          
          // Hybrid search for compare too
          const queryEmbedding = await embedModel.getTextEmbedding(topic);
          const [kgResults, chunkResults] = await Promise.all([
            index.query(topic, DEFAULT_QUERY_OPTIONS),
            directSourceChunkSearch(queryEmbedding, 15),
          ]);
          const results = mergeResults(kgResults, chunkResults);
          const sources = getDocumentSources(results);
          lastSources = sources;
          
          console.log(`   Found ${results.length} relevant passages from ${sources.size} documents\n`);
          
          console.log("🤖 Assistant: ");
          const response = await generateResponse(compareQuery, results, sources);
          console.log(response);
          
          console.log("\n📚 Sources:");
          for (const [doc, count] of sources.entries()) {
            console.log(`   • ${doc}: ${count} passages`);
          }
          console.log();
        } catch (error: any) {
          console.error("\n❌ Error:", error.message);
          console.log();
        }
        
        askQuestion();
        return;
      }
      
      try {
        // Query the knowledge graph + direct source chunk search (hybrid)
        console.log("\n🔍 Searching...");
        
        // Get query embedding for direct chunk search
        const queryEmbedding = await embedModel.getTextEmbedding(query);
        
        // Run both searches in parallel
        const [kgResults, chunkResults] = await Promise.all([
          index.query(query, DEFAULT_QUERY_OPTIONS),
          directSourceChunkSearch(queryEmbedding, 15),
        ]);
        
        // Merge results (KG results first, then direct chunk matches)
        let results = mergeResults(kgResults, chunkResults);
        
        // Apply document filter if set
        if (documentFilter.length > 0) {
          results = filterResultsByDocument(results, documentFilter);
          console.log(`   Found ${results.length} passages (filtered to: ${documentFilter.join(", ")})`);
        } else {
          console.log(`   Found ${results.length} relevant passages`);
        }
        
        // Get document sources
        const sources = getDocumentSources(results);
        lastSources = sources;
        
        if (sources.size > 1) {
          console.log(`   Spanning ${sources.size} documents: ${Array.from(sources.keys()).join(", ")}`);
        }
        console.log();
        
        // Generate AI response
        console.log("🤖 Assistant: ");
        const response = await generateResponse(query, results, sources);
        console.log(response);
        
        // Show sources
        if (sources.size > 0) {
          console.log("\n📚 Sources:");
          for (const [doc, count] of sources.entries()) {
            console.log(`   • ${doc}: ${count} passages`);
          }
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
