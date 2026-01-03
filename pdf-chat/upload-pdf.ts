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

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.LITELLM_API_KEY,
  baseURL: process.env.LITELLM_PROXY_URL,
});

// Embedding model wrapper
let embeddingCount = 0;
const embedModel = {
  async getTextEmbedding(text: string): Promise<number[]> {
    embeddingCount++;
    const truncatedText = text.length > 50 ? text.slice(0, 50) + "..." : text;
    console.log(`   [Embed #${embeddingCount}] Embedding: "${truncatedText}"`);
    
    const response = await openai.embeddings.create({
      model: process.env.DEFAULT_EMBEDDING_MODEL || "text-embedding-3-small",
      input: text,
      encoding_format: "base64",
    });
    
    const b64 = response.data[0].embedding as unknown as string;
    const buffer = Buffer.from(b64, "base64");
    const float32Array = new Float32Array(buffer.buffer);
    console.log(`   [Embed #${embeddingCount}] ✅ Got ${float32Array.length}-dim vector`);
    return Array.from(float32Array);
  },
  
  async getTextEmbeddingBatch(texts: string[]): Promise<number[][]> {
    console.log(`   [Embed] Batch embedding ${texts.length} texts...`);
    return Promise.all(texts.map((t) => this.getTextEmbedding(t)));
  },
};

// LLM client wrapper implementing the LLMClient interface
const llmClient = {
  async structuredPredict<T>(schema: import("zod").ZodType<T>, prompt: string): Promise<T> {
    console.log(`   [LLM] Calling ${process.env.DEFAULT_LLM_MODEL || "gpt-4"} for entity extraction...`);
    
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
    console.log(`   [LLM] Response received (${content.length} chars)`);
    
    const parsed = JSON.parse(content);
    
    // Use safeParse to handle validation errors gracefully
    const result = schema.safeParse(parsed);
    if (result.success) {
      console.log(`   [LLM] ✅ Validation passed`);
      return result.data;
    } else {
      // Log validation errors but try to salvage what we can
      console.log(`   [LLM] ⚠️  Validation issues: ${result.error.issues.length} problems`);
      for (const issue of result.error.issues) {
        console.log(`         - ${issue.path.join('.')}: ${issue.message}`);
      }
      // Return empty triplets if validation fails completely
      // The library's SchemaLLMPathExtractor will handle this gracefully
      return { triplets: [] } as T;
    }
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

/**
 * Extract text from PDF
 */
async function extractPdfText(pdfPath: string): Promise<string> {
  console.log(`\n📄 Loading PDF: ${pdfPath}`);
  
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF file not found: ${pdfPath}`);
  }
  
  const dataBuffer = fs.readFileSync(pdfPath);
  const data = await pdfParse(dataBuffer);
  
  console.log(`   Pages: ${data.numpages}`);
  console.log(`   Text length: ${data.text.length} characters`);
  
  return data.text;
}

async function main() {
  console.log("=".repeat(70));
  console.log("  PDF Upload & Knowledge Graph Extraction");
  console.log("=".repeat(70));
  
  // 1. Extract PDF text
  const pdfText = await extractPdfText(PDF_PATH);
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
  });
  
  // Define schema for entity extraction
  const schema = {
    entityTypes: ["PERSON", "ORGANIZATION", "LOCATION", "PRODUCT", "CONCEPT", "DATE"],
    relationTypes: [
      "WORKS_AT",
      "LOCATED_IN",
      "PRODUCES",
      "FOUNDED_BY",
      "PART_OF",
      "RELATED_TO",
      "OCCURRED_ON",
    ],
    validationSchema: [
      ["PERSON", "WORKS_AT", "ORGANIZATION"],
      ["ORGANIZATION", "LOCATED_IN", "LOCATION"],
      ["ORGANIZATION", "PRODUCES", "PRODUCT"],
      ["ORGANIZATION", "FOUNDED_BY", "PERSON"],
      ["PRODUCT", "PART_OF", "ORGANIZATION"],
      ["CONCEPT", "RELATED_TO", "CONCEPT"],
      ["PERSON", "RELATED_TO", "PERSON"],
      ["ORGANIZATION", "RELATED_TO", "ORGANIZATION"],
    ] as [string, string, string][],
  };
  
  const index = new PropertyGraphIndex({
    propertyGraphStore: graphStore,
    embedModel,
    kgExtractors: [
      new SchemaLLMPathExtractor({
        llm: llmClient,
        schema,
        maxTripletsPerChunk: 15,
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
