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
} from "hana-kgvector";
import OpenAI from "openai";
import dotenv from "dotenv";
import * as readline from "readline";

dotenv.config({ path: ".env.local" });

// Configuration
const GRAPH_NAME = "pdf_documents";

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.LITELLM_API_KEY,
  baseURL: process.env.LITELLM_PROXY_URL,
});

// Embedding model wrapper
const embedModel = {
  async getTextEmbedding(text: string): Promise<number[]> {
    const response = await openai.embeddings.create({
      model: process.env.DEFAULT_EMBEDDING_MODEL || "text-embedding-3-small",
      input: text,
      encoding_format: "base64",
    });
    
    const b64 = response.data[0].embedding as unknown as string;
    const buffer = Buffer.from(b64, "base64");
    const float32Array = new Float32Array(buffer.buffer);
    return Array.from(float32Array);
  },
  
  async getTextEmbeddingBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.getTextEmbedding(t)));
  },
};

/**
 * Format results for display
 */
function formatResults(results: any[]): string {
  if (results.length === 0) {
    return "No relevant information found.";
  }
  
  const output: string[] = [];
  
  // Group results by document
  const byDocument = new Map<string, any[]>();
  for (const result of results) {
    const docId = result.node.metadata?.documentId || "unknown";
    if (!byDocument.has(docId)) {
      byDocument.set(docId, []);
    }
    byDocument.get(docId)!.push(result);
  }
  
  // Format each document's results
  for (const [docId, docResults] of byDocument.entries()) {
    output.push(`\n📄 From document: ${docId}`);
    output.push("─".repeat(60));
    
    // Show top 3 results from this document
    for (const result of docResults.slice(0, 3)) {
      const score = result.score?.toFixed(3) || "N/A";
      const text = result.node.text.trim();
      const preview = text.length > 300 ? text.slice(0, 300) + "..." : text;
      
      output.push(`\n[Relevance: ${score}]`);
      output.push(preview);
    }
  }
  
  return output.join("\n");
}

/**
 * Generate AI response using retrieved context
 */
async function generateResponse(query: string, results: any[]): Promise<string> {
  if (results.length === 0) {
    return "I don't have enough information in the uploaded documents to answer that question.";
  }
  
  // Build context from top results
  const context = results
    .slice(0, 5)
    .map((r, i) => `[${i + 1}] ${r.node.text}`)
    .join("\n\n");
  
  const systemPrompt = `You are a helpful assistant that answers questions based on the provided document context. 
Use only the information from the context to answer questions. If the context doesn't contain enough information, say so.
Be concise and accurate.`;
  
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
  
  // Chat loop
  const askQuestion = () => {
    rl.question("You: ", async (input) => {
      const query = input.trim();
      
      if (!query) {
        askQuestion();
        return;
      }
      
      // Handle commands
      if (query.toLowerCase() === "exit" || query.toLowerCase() === "quit") {
        console.log("\n👋 Goodbye!\n");
        rl.close();
        process.exit(0);
        return;
      }
      
      if (query.toLowerCase() === "help") {
        console.log("\n📖 Available commands:");
        console.log("   - Ask any question about your documents");
        console.log("   - 'exit' or 'quit' - Exit the chat");
        console.log("   - 'help' - Show this help message");
        console.log("   - 'raw' - Toggle raw results display\n");
        askQuestion();
        return;
      }
      
      try {
        // Query the knowledge graph
        console.log("\n🔍 Searching...");
        
        const results = await index.query(query, {
          similarityTopK: 5,
          pathDepth: 2,
          limit: 30,
          crossCheckBoost: true,
        });
        
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
