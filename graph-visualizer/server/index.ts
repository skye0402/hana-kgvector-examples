/**
 * KG-RAG Visualization Server
 * 
 * Express server that queries the HANA knowledge graph and returns
 * structured data for visualization.
 * 
 * Updated for multi-doc-chat with image support.
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import {
  createHanaConnection,
  HanaPropertyGraphStore,
  PropertyGraphIndex,
  ImplicitPathExtractor,
  KG_SOURCE_REL,
  hanaExec,
} from "hana-kgvector";

// Load config from multi-doc-chat
dotenv.config({ path: "../multi-doc-chat/.env.local" });

const app = express();
app.use(cors());
app.use(express.json());

// Serve extracted images as static files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const IMAGES_DIR = path.resolve(__dirname, "../../multi-doc-chat/extracted_images");
app.use("/images", express.static(IMAGES_DIR));

const PORT = process.env.PORT || 3001;
const GRAPH_NAME = process.env.GRAPH_NAME || "MULTI_DOC_GRAPH";
const IMAGE_TABLE_NAME = `${GRAPH_NAME}_IMAGES`;
const EMBEDDING_MODEL = process.env.DEFAULT_EMBEDDING_MODEL || "text-embedding-3-small";

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.LITELLM_API_KEY,
  baseURL: process.env.LITELLM_PROXY_URL,
});

// Embedding model wrapper
const embedModel = {
  async getTextEmbedding(text: string): Promise<number[]> {
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
  },
  
  async getTextEmbeddingBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.getTextEmbedding(t)));
  },
};

// Store connection and index globally
let conn: any = null;
let graphStore: HanaPropertyGraphStore | null = null;
let index: PropertyGraphIndex | null = null;

async function initializeConnection() {
  console.log("🔌 Connecting to HANA Cloud...");
  conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    port: parseInt(process.env.HANA_PORT || "443"),
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });
  
  graphStore = new HanaPropertyGraphStore(conn, { graphName: GRAPH_NAME });
  index = new PropertyGraphIndex({
    propertyGraphStore: graphStore,
    embedModel,
    kgExtractors: [new ImplicitPathExtractor()],
    embedKgNodes: false,
  });
  
  console.log("✅ Connected to HANA Cloud");
  console.log(`   Graph: ${GRAPH_NAME}`);
  console.log(`   Images dir: ${IMAGES_DIR}`);
}

// Entity type to color mapping
const TYPE_COLORS: Record<string, string> = {
  PERSON: "#ef4444",
  ORGANIZATION: "#3b82f6",
  PRODUCT: "#22c55e",
  SERVICE: "#a855f7",
  TECHNOLOGY: "#f97316",
  CONCEPT: "#06b6d4",
  FEATURE: "#eab308",
  PROCESS: "#ec4899",
  LOCATION: "#14b8a6",
  EVENT: "#8b5cf6",
  DATE: "#64748b",
  DOCUMENT: "#78716c",
  DEFAULT: "#6b7280",
};

function getNodeColor(label: string): string {
  return TYPE_COLORS[label?.toUpperCase()] || TYPE_COLORS.DEFAULT;
}

interface GraphNode {
  id: string;
  label: string;
  name: string;
  color: string;
  isVectorMatch: boolean;
  score?: number;
}

interface GraphLink {
  source: string;
  target: string;
  label: string;
}

interface ImageInfo {
  imageId: string;
  pageNumber: number;
  documentId: string;
  imagePath: string;  // URL path to serve the image
  description: string;
}

interface QueryResponse {
  answer: string;
  graph: {
    nodes: GraphNode[];
    links: GraphLink[];
  };
  vectorMatches: Array<{ id: string; name: string; label: string; score: number }>;
  images: ImageInfo[];
  stats: {
    vectorMatchCount: number;
    tripletCount: number;
    nodeCount: number;
    edgeCount: number;
    imageCount: number;
  };
}

// Query endpoint
app.post("/api/query", async (req, res) => {
  try {
    const { query } = req.body;
    
    if (!query || typeof query !== "string") {
      return res.status(400).json({ error: "Query is required" });
    }
    
    if (!graphStore || !index) {
      return res.status(503).json({ error: "Database not connected" });
    }
    
    console.log(`\n🔍 Query: "${query}"`);
    
    // 1. Get query embedding
    const embedding = await embedModel.getTextEmbedding(query);
    
    // 2. Vector search for similar KG nodes
    const [kgNodes, scores] = await graphStore.vectorQuery({
      queryEmbedding: embedding,
      similarityTopK: 5,
    });
    
    const vectorMatches = (kgNodes || []).map((n: any, i: number) => ({
      id: n?.id || `node_${i}`,
      name: n?.name || n?.id || "Unknown",
      label: n?.label || "ENTITY",
      score: scores?.[i] || 0,
    }));
    
    console.log(`   Vector matches: ${vectorMatches.length}`);
    
    // 3. Expand graph from matched nodes
    const triplets = await graphStore.getRelMap({
      nodes: kgNodes || [],
      depth: 2,
      limit: 50,
      ignoreRels: [KG_SOURCE_REL],
    });
    
    // 4. Build graph data for visualization
    const nodeMap = new Map<string, GraphNode>();
    const links: GraphLink[] = [];
    const vectorMatchIds = new Set(vectorMatches.map((v) => v.id));
    
    // Filter out metadata triplets
    const semanticTriplets = (triplets as any[]).filter((t) => {
      const pred = t?.[1]?.label ?? t?.[1]?.id ?? "";
      if (!pred) return false;
      if (pred.includes("urn:hkv:prop:")) return false;
      if (pred === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type") return false;
      if (pred === "FROM_DOCUMENT") return false;
      return true;
    });
    
    for (const triplet of semanticTriplets) {
      const [s, p, o] = triplet;
      
      const subjectId = s?.id || `s_${Math.random()}`;
      const objectId = o?.id || `o_${Math.random()}`;
      const predLabel = p?.label || p?.id || "RELATED_TO";
      
      // Add subject node
      if (!nodeMap.has(subjectId)) {
        nodeMap.set(subjectId, {
          id: subjectId,
          label: s?.label || "ENTITY",
          name: s?.name || s?.id || "Unknown",
          color: getNodeColor(s?.label),
          isVectorMatch: vectorMatchIds.has(subjectId),
          score: vectorMatches.find((v) => v.id === subjectId)?.score,
        });
      }
      
      // Add object node
      if (!nodeMap.has(objectId)) {
        nodeMap.set(objectId, {
          id: objectId,
          label: o?.label || "ENTITY",
          name: o?.name || o?.id || "Unknown",
          color: getNodeColor(o?.label),
          isVectorMatch: vectorMatchIds.has(objectId),
          score: vectorMatches.find((v) => v.id === objectId)?.score,
        });
      }
      
      // Add edge
      links.push({
        source: subjectId,
        target: objectId,
        label: predLabel,
      });
    }
    
    const nodes = Array.from(nodeMap.values());
    
    console.log(`   Graph: ${nodes.length} nodes, ${links.length} edges`);
    
    // 5. Get answer from index (with structural edges for image retrieval)
    const results = await index.query(query, {
      similarityTopK: 5,
      pathDepth: 2,
      limit: 30,
      crossCheckBoost: true,
      crossCheckBoostFactor: 1.25,
      // Note: includeStructuralEdges requires hana-kgvector >= 0.1.8
    } as any);
    
    // 6. Extract images from results
    const images: ImageInfo[] = [];
    const seenImageIds = new Set<string>();
    
    for (const r of results) {
      const meta = r?.node?.metadata as any;
      if (meta?.contentType === "image" && meta?.imageId && !seenImageIds.has(meta.imageId)) {
        seenImageIds.add(meta.imageId);
        
        // Look up image path from _IMAGES table
        let imagePath = meta.imagePath || "";
        try {
          const imgRows: any = await hanaExec(conn, 
            `SELECT IMAGE_PATH FROM "${IMAGE_TABLE_NAME}" WHERE IMAGE_ID = '${meta.imageId}'`
          );
          if (imgRows?.[0]?.IMAGE_PATH) {
            // Convert local path to URL path (e.g., extracted_images/DOC/img.png -> /images/DOC/img.png)
            const localPath = imgRows[0].IMAGE_PATH;
            imagePath = "/images/" + localPath.replace(/^.*extracted_images[\/\\]/, "");
          }
        } catch {
          // Use metadata path as fallback
          if (imagePath) {
            imagePath = "/images/" + imagePath.replace(/^.*extracted_images[\/\\]/, "");
          }
        }
        
        images.push({
          imageId: meta.imageId,
          pageNumber: meta.pageNumber || 0,
          documentId: meta.documentId || "unknown",
          imagePath,
          description: r.node.text || "",
        });
      }
    }
    
    console.log(`   Images found: ${images.length}`);
    
    // 7. Generate AI response
    let answer = "I don't have enough information to answer that question.";
    
    if (results.length > 0) {
      const context = results
        .slice(0, 8)
        .map((r, i) => {
          const meta = r?.node?.metadata as any;
          const prefix = meta?.contentType === "image" 
            ? `[${i + 1}] [IMAGE: ${meta?.imageId || "unknown"}] ` 
            : `[${i + 1}] `;
          return prefix + r.node.text;
        })
        .join("\n\n");
      
      const response = await openai.chat.completions.create({
        model: process.env.DEFAULT_LLM_MODEL || "gpt-4",
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant that answers questions based only on the provided document context. When referring to images, include their ID (e.g., 'Image ID: xxx'). Be concise.",
          },
          {
            role: "user",
            content: `Context:\n${context}\n\nQuestion: ${query}\n\nAnswer:`,
          },
        ],
        temperature: 0.3,
      });
      
      answer = response.choices[0]?.message?.content || answer;
    }
    
    const result: QueryResponse = {
      answer,
      graph: { nodes, links },
      vectorMatches,
      images,
      stats: {
        vectorMatchCount: vectorMatches.length,
        tripletCount: semanticTriplets.length,
        nodeCount: nodes.length,
        edgeCount: links.length,
        imageCount: images.length,
      },
    };
    
    console.log(`   Answer generated (${answer.length} chars)`);
    
    res.json(result);
  } catch (error: any) {
    console.error("Query error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get("/api/health", (req, res) => {
  res.json({ 
    status: graphStore ? "connected" : "disconnected",
    graph: GRAPH_NAME,
  });
});

// Start server
initializeConnection()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n🚀 Server running at http://localhost:${PORT}`);
      console.log(`   Graph: ${GRAPH_NAME}`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize:", error);
    process.exit(1);
  });
