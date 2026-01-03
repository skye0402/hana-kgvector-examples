/**
 * PDF Upload Example
 * 
 * This script demonstrates how to:
 * 1. Load a PDF document
 * 2. Extract text and chunk it
 * 3. Build a knowledge graph with entities and relations
 * 4. Store everything in HANA Cloud
 * 
 * Usage: pnpm upload
 */

import {
  createHanaConnection,
  HanaPropertyGraphStore,
  PropertyGraphIndex,
  SchemaLLMPathExtractor,
  ImplicitPathExtractor,
} from "hana-kgvector";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import pdfParse from "pdf-parse";

dotenv.config({ path: ".env.local" });

// Configuration
const PDF_PATH = process.argv[2] || "./sample.pdf";
const GRAPH_NAME = "pdf_documents";
const CHUNK_SIZE = 1000; // characters per chunk
const CHUNK_OVERLAP = 100;
const SCHEMA_SAMPLE_PAGES = 6; // Number of pages to sample for schema induction
const AUTO_DISCOVER_SCHEMA = true; // Set to false to use hardcoded schema
const HUMAN_REVIEW = false; // Set to true to prompt for schema approval
const RESET_TABLES = true;
// maxTripletsPerChunk is a PROMPT HINT, not a hard cap!
// - Low values (10-15): LLM tries to hit exactly that number (inflates extraction)
// - High values (100+): LLM extracts naturally without artificial inflation
// - Library default is 10, which causes uniform "10 triplets per chunk"
const TRIPLETS_PER_CHUNK: number = 100; // Use high value for natural extraction

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.LITELLM_API_KEY,
  baseURL: process.env.LITELLM_PROXY_URL,
});

// Embedding model wrapper with retry logic and deduplication
let embeddingCount = 0;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const EMBED_CONCURRENCY = 5; // Process 5 embeddings in parallel
const VERBOSE_EMBED_LOG = false; // Set to true to see every embedding

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const embedModel = {
  async getTextEmbedding(text: string): Promise<number[]> {
    const currentCount = ++embeddingCount;
    
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await openai.embeddings.create({
          model: process.env.DEFAULT_EMBEDDING_MODEL || "text-embedding-3-small",
          input: text,
          encoding_format: "float"
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
        
        // Validate embedding - check for null/NaN/Infinity values
        const hasInvalidValues = embedding.some(v => v === null || !Number.isFinite(v));
        if (hasInvalidValues) {
          console.log(`   [Embed #${currentCount}] ⚠️ Invalid values in embedding, retrying...`);
          throw new Error("Embedding contains invalid values (null/NaN/Infinity)");
        }

        // Sanity check: embeddings should be small-magnitude numbers (typically ~[-1, 1]).
        // If we see huge magnitudes, it's almost certainly a decoding/format issue.
        const maxAbs = embedding.reduce((m, v) => Math.max(m, Math.abs(v as number)), 0);
        if (maxAbs > 100) {
          console.log(
            `   [Embed #${currentCount}] ⚠️ Suspicious embedding magnitude maxAbs=${maxAbs.toExponential(2)}, retrying...`
          );
          throw new Error("Embedding magnitude too large; likely decode/format mismatch");
        }
        
        if (VERBOSE_EMBED_LOG) {
          const truncatedText = text.length > 40 ? text.slice(0, 40) + "..." : text;
          console.log(`   [Embed #${currentCount}] "${truncatedText}" → ${embedding.length}d`);
        }
        return embedding;
      } catch (error: any) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * attempt;
          console.log(`   [Embed #${currentCount}] ⚠️ Retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
          await sleep(delay);
        }
      }
    }
    throw lastError;
  },
  
  async getTextEmbeddingBatch(texts: string[]): Promise<number[][]> {
    // Deduplicate texts to avoid redundant API calls
    const uniqueTexts = [...new Set(texts)];
    const duplicateCount = texts.length - uniqueTexts.length;
    
    console.log(`   [Embed] Processing ${texts.length} texts → ${uniqueTexts.length} unique (${duplicateCount} duplicates)`);
    
    // Build cache of unique embeddings with parallel processing
    const cache = new Map<string, number[]>();
    const startTime = Date.now();
    
    for (let i = 0; i < uniqueTexts.length; i += EMBED_CONCURRENCY) {
      const batch = uniqueTexts.slice(i, i + EMBED_CONCURRENCY);
      const embeddings = await Promise.all(batch.map(t => this.getTextEmbedding(t)));
      batch.forEach((text, idx) => cache.set(text, embeddings[idx]));
      
      // Progress update every 20 embeddings
      if ((i + EMBED_CONCURRENCY) % 20 === 0 || i + EMBED_CONCURRENCY >= uniqueTexts.length) {
        const done = Math.min(i + EMBED_CONCURRENCY, uniqueTexts.length);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`   [Embed] Progress: ${done}/${uniqueTexts.length} (${elapsed}s)`);
      }
    }
    
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`   [Embed] ✅ Completed ${uniqueTexts.length} embeddings in ${totalTime}s`);
    
    // Return embeddings in original order (including duplicates)
    return texts.map(t => cache.get(t)!);
  },
};

// LLM client wrapper implementing the LLMClient interface with retry logic
let llmCallCount = 0;
let totalTriplets = 0;
const llmClient = {
  async structuredPredict<T>(schema: import("zod").ZodType<T>, prompt: string): Promise<T> {
    const callNum = ++llmCallCount;
    console.log(`   [LLM #${callNum}] Extracting entities...`);
    
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await openai.chat.completions.create({
          model: process.env.DEFAULT_LLM_MODEL || "gpt-4",
          messages: [
            {
              role: "system",
              content: "You are a helpful assistant that extracts structured information. Always respond with valid JSON matching the requested schema. IMPORTANT: Only use the exact relation types provided in the schema.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        });
        
        const content = response.choices[0]?.message?.content || "{}";
        const parsed = JSON.parse(content);
        
        // Use safeParse to handle validation errors gracefully
        const result = schema.safeParse(parsed);
        if (result.success) {
          const tripletCount = (result.data as any).triplets?.length || 0;
          totalTriplets += tripletCount;
          console.log(`   [LLM #${callNum}] ✅ ${tripletCount} triplets extracted (total: ${totalTriplets})`);
          return result.data;
        } else {
          console.log(`   [LLM #${callNum}] ⚠️  Validation failed: ${result.error.issues.length} issues`);
          return { triplets: [] } as T;
        }
      } catch (error: any) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * attempt;
          console.log(`   [LLM #${callNum}] ⚠️ Retry ${attempt}/${MAX_RETRIES} after ${delay}ms`);
          await sleep(delay);
        }
      }
    }
    console.log(`   [LLM #${callNum}] ❌ Failed after ${MAX_RETRIES} retries`);
    return { triplets: [] } as T;
  },
};

/**
 * Chunk text into overlapping segments
 */
function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start += chunkSize - overlap;
  }
  
  return chunks;
}

interface DiscoveredSchema {
  entityTypes: string[];
  relationTypes: string[];
  description: string;
}

/**
 * Schema Induction: Analyze document sample to discover appropriate entity and relation types
 * This makes the extraction domain-agnostic - works for legal, medical, technical, etc.
 */
async function discoverSchema(textSample: string): Promise<DiscoveredSchema> {
  console.log("\n🔬 Schema Induction: Analyzing document to discover domain-specific schema...");
  console.log(`   Sample size: ${textSample.length} characters`);
  
  const inductionPrompt = `You are a Knowledge Graph schema designer. Analyze the provided text and define an optimal schema for extracting a Knowledge Graph.

Constraints:
1. Identify 5-8 Entity Types that capture the main concepts (e.g., PERSON, ORGANIZATION, PRODUCT)
2. Identify 8-12 Relation Types that capture how entities relate (e.g., WORKS_AT, PRODUCES)
3. Entity types must be UPPER_SNAKE_CASE nouns
4. Relation types must be UPPER_SNAKE_CASE verbs
5. Avoid overly generic relations like "HAS" or "IS" - be specific
6. Always include "RELATED_TO" as a fallback relation type
7. Focus on relations that would help answer questions about this document

Input Text (sample):
---
${textSample}
---

Return ONLY a valid JSON object with this exact structure:
{
  "entityTypes": ["TYPE_1", "TYPE_2", ...],
  "relationTypes": ["RELATION_1", "RELATION_2", ..., "RELATED_TO"],
  "description": "Brief description of what domain/topic this schema covers"
}`;

  const response = await openai.chat.completions.create({
    model: process.env.DEFAULT_LLM_MODEL || "gpt-4",
    messages: [
      {
        role: "system",
        content: "You are an expert at designing Knowledge Graph schemas. Return only valid JSON.",
      },
      { role: "user", content: inductionPrompt },
    ],
    temperature: 0.3,
    response_format: { type: "json_object" },
  });

  const content = response.choices[0]?.message?.content || "{}";
  const schema = JSON.parse(content) as DiscoveredSchema;
  
  // Ensure RELATED_TO is always included as fallback
  if (!schema.relationTypes.includes("RELATED_TO")) {
    schema.relationTypes.push("RELATED_TO");
  }
  
  console.log(`\n   📋 Discovered Schema:`);
  console.log(`   Description: ${schema.description}`);
  console.log(`   Entity Types (${schema.entityTypes.length}): ${schema.entityTypes.join(", ")}`);
  console.log(`   Relation Types (${schema.relationTypes.length}): ${schema.relationTypes.join(", ")}`);
  
  return schema;
}

/**
 * Optional: Prompt user to review and approve the discovered schema
 */
async function reviewSchema(schema: DiscoveredSchema): Promise<DiscoveredSchema> {
  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log("\n🔍 Schema Review (Human-in-the-loop):");
    console.log(JSON.stringify(schema, null, 2));
    
    rl.question("\nApprove this schema? (y/n/edit): ", (answer) => {
      rl.close();
      if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
        console.log("   ✅ Schema approved");
        resolve(schema);
      } else if (answer.toLowerCase() === "edit") {
        console.log("   ⚠️  Manual editing not implemented - using discovered schema");
        resolve(schema);
      } else {
        console.log("   ⚠️  Schema rejected - using discovered schema anyway (implement rejection handling as needed)");
        resolve(schema);
      }
    });
  });
}

/**
 * Fallback schema for when auto-discovery is disabled
 */
function getDefaultSchema(): DiscoveredSchema {
  return {
    entityTypes: [
      "PERSON", "ORGANIZATION", "LOCATION", "PRODUCT",
      "SERVICE", "TECHNOLOGY", "CONCEPT", "EVENT", "DATE"
    ],
    relationTypes: [
      "WORKS_AT", "LEADS", "MANAGES", "FOUNDED_BY",
      "LOCATED_IN", "HEADQUARTERED_IN", "OPERATES_IN",
      "PRODUCES", "PROVIDES", "USES", "REQUIRES",
      "PART_OF", "CONTAINS", "SUBSIDIARY_OF", "PARTNER_OF",
      "ACQUIRED", "MERGED_WITH", "INVESTED_IN", "LAUNCHED",
      "SUPPORTS", "ENABLES", "INTEGRATES_WITH", "DEPENDS_ON",
      "OCCURRED_ON", "STARTED_ON", "ENDED_ON",
      "RELATED_TO"
    ],
    description: "General-purpose schema for business/technical documents"
  };
}

interface PdfData {
  text: string;
  pages: string[];
  numPages: number;
}

/**
 * Extract text from PDF with page-level access
 */
async function extractPdfText(pdfPath: string): Promise<PdfData> {
  console.log(`\n📄 Loading PDF: ${pdfPath}`);
  
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF file not found: ${pdfPath}`);
  }
  
  const dataBuffer = fs.readFileSync(pdfPath);
  
  // Extract per-page text
  const pages: string[] = [];
  const data = await pdfParse(dataBuffer, {
    pagerender: (pageData: any) => {
      return pageData.getTextContent().then((textContent: any) => {
        const pageText = textContent.items.map((item: any) => item.str).join(" ");
        pages.push(pageText);
        return pageText;
      });
    }
  });
  
  console.log(`   Pages: ${data.numpages}`);
  console.log(`   Text length: ${data.text.length} characters`);
  
  return { text: data.text, pages, numPages: data.numpages };
}

/**
 * Sample pages for schema induction: first 3 pages + random pages from the rest
 * This gives a better overview of document content than just the beginning
 */
function samplePagesForSchema(pages: string[], sampleCount: number): string {
  if (pages.length === 0) return "";
  
  // Always include first 3 pages (or all if fewer)
  const firstPages = pages.slice(0, Math.min(3, pages.length));
  const remainingPages = pages.slice(3);
  
  // Calculate how many random pages we need
  const randomCount = Math.max(0, sampleCount - firstPages.length);
  
  // Pick evenly-distributed pages from the rest of the document
  const randomPages: string[] = [];
  const step = randomCount > 0 && remainingPages.length > 0 
    ? Math.max(1, Math.floor(remainingPages.length / randomCount)) 
    : 1;
  if (randomCount > 0 && remainingPages.length > 0) {
    for (let i = 0; i < remainingPages.length && randomPages.length < randomCount; i += step) {
      randomPages.push(remainingPages[i]);
    }
  }
  
  const sampledPages = [...firstPages, ...randomPages];
  
  // Build page indices for logging (1-indexed)
  const sampledIndices = [
    ...firstPages.map((_, i) => i + 1),
    ...randomPages.map((_, i) => 4 + i * step)
  ];
  
  console.log(`   Sampled ${sampledPages.length} pages for schema induction: pages ${sampledIndices.join(", ")}`);
  
  return sampledPages.join("\n\n--- Page Break ---\n\n");
}

async function main() {
  console.log("=".repeat(70));
  console.log("  PDF Upload & Knowledge Graph Extraction");
  console.log("=".repeat(70));
  
  // 1. Extract PDF text
  const pdfData = await extractPdfText(PDF_PATH);
  const pdfText = pdfData.text;
  const pdfName = path.basename(PDF_PATH, ".pdf");
  
  // 2. Chunk the text
  console.log(`\n✂️  Chunking text (size: ${CHUNK_SIZE}, overlap: ${CHUNK_OVERLAP})`);
  const chunks = chunkText(pdfText, CHUNK_SIZE, CHUNK_OVERLAP);
  console.log(`   Created ${chunks.length} chunks`);
  
  // 3. Connect to HANA
  console.log("\n🔌 Connecting to HANA Cloud...");
  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    port: parseInt(process.env.HANA_PORT || "443"),
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });
  console.log("   ✅ Connected");
  
  // 4. Create graph store and index
  console.log(`\n🗄️  Initializing graph store (graph: ${GRAPH_NAME})`);
  const graphStore = new HanaPropertyGraphStore(conn, {
    graphName: GRAPH_NAME,
    resetTables: RESET_TABLES,
  });
  
  // 5. Schema Induction: Discover or use default schema
  let schema: DiscoveredSchema;
  
  if (AUTO_DISCOVER_SCHEMA) {
    // Sample pages from throughout the document for better schema coverage
    const sampleText = samplePagesForSchema(pdfData.pages, SCHEMA_SAMPLE_PAGES);
    schema = await discoverSchema(sampleText);
    
    // Optional: Human review of discovered schema
    if (HUMAN_REVIEW) {
      schema = await reviewSchema(schema);
    }
  } else {
    console.log("\n📋 Using default schema (AUTO_DISCOVER_SCHEMA=false)");
    schema = getDefaultSchema();
  }
  
  const index = new PropertyGraphIndex({
    propertyGraphStore: graphStore,
    embedModel,
    kgExtractors: [
      new SchemaLLMPathExtractor({
        llm: llmClient,
        schema,
        maxTripletsPerChunk: TRIPLETS_PER_CHUNK,
        strict: false, // Allow relations not in validationSchema
      }),
      new ImplicitPathExtractor(),
    ],
    embedKgNodes: true,
    showProgress: true,
  });
  
  // 5. Prepare documents for insertion
  console.log("\n📝 Preparing documents for insertion...");
  const documents = chunks.map((chunk, idx) => ({
    id: `${pdfName}_chunk_${idx}`,
    text: chunk,
    metadata: {
      documentId: pdfName,
      source: PDF_PATH,
      chunkIndex: idx,
      totalChunks: chunks.length,
    },
  }));
  
  // 6. Insert documents and extract knowledge graph
  console.log(`\n🚀 Inserting ${documents.length} chunks and extracting knowledge graph...`);
  console.log("   This may take a few minutes depending on document size.\n");
  
  const startTime = Date.now();
  const insertedNodes = await index.insert(documents);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log(`\n✅ Insertion complete in ${duration}s`);
  console.log(`   Processed ${insertedNodes.length} document chunks`);
  
  // 7. Show extraction statistics
  let totalEntities = 0;
  let totalRelations = 0;
  
  for (const node of insertedNodes) {
    const entities = (node.metadata.kg_nodes as any[]) ?? [];
    const relations = (node.metadata.kg_relations as any[]) ?? [];
    totalEntities += entities.length;
    totalRelations += relations.length;
  }
  
  console.log(`\n📊 Extraction Statistics:`);
  console.log(`   Total entities extracted: ${totalEntities}`);
  console.log(`   Total relations extracted: ${totalRelations}`);
  console.log(`   Average entities per chunk: ${(totalEntities / chunks.length).toFixed(1)}`);
  console.log(`   Average relations per chunk: ${(totalRelations / chunks.length).toFixed(1)}`);
  
  // 8. Test query
  console.log(`\n🔍 Testing retrieval with sample query...`);
  const testQuery = "What is this document about?";
  console.log(`   Query: "${testQuery}"`);
  
  const results = await index.query(testQuery, {
    similarityTopK: 3,
    pathDepth: 1,
    limit: 10,
  });
  
  console.log(`   Found ${results.length} relevant results`);
  if (results.length > 0) {
    console.log(`\n   Top result (score: ${results[0].score?.toFixed(3)}):`);
    console.log(`   ${results[0].node.text.slice(0, 200)}...`);
  }
  
  console.log("\n" + "=".repeat(70));
  console.log("✅ Upload complete! You can now run 'pnpm chat' to query the document.");
  console.log("=".repeat(70) + "\n");
  
  process.exit(0);
}

main().catch((error) => {
  console.error("\n❌ Error:", error.message);
  process.exit(1);
});
