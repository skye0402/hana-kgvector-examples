/**
 * Multi-Document Upload Example with Image Processing
 * 
 * This script demonstrates how to:
 * 1. Upload multiple PDF documents to the same knowledge graph
 * 2. Extract and process images from PDFs using VLM descriptions
 * 3. Track document metadata including page numbers for filtering
 * 4. Store images in a separate HANA BLOB table
 * 5. Build cross-document relationships
 * 
 * Usage: 
 *   pnpm upload doc1.pdf doc2.pdf doc3.pdf
 *   pnpm upload ./docs/*.pdf
 *   pnpm upload doc1.pdf --reset    # Clear existing data first
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
import { createCanvas } from "@napi-rs/canvas";

dotenv.config({ path: ".env.local" });

// Configuration
const GRAPH_NAME = "MULTI_DOC_GRAPH";
const IMAGE_TABLE_NAME = `${GRAPH_NAME}_IMAGES`;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 100;
const SCHEMA_SAMPLE_PAGES = 6;
const TRIPLETS_PER_CHUNK = 100;
const MIN_IMAGE_SIZE = 100; // Skip images smaller than 100x100 (likely icons/noise)
const IMAGES_OUTPUT_DIR = "./extracted_images"; // Local folder for extracted images

// Pass --reset to clear existing data
const RESET_TABLES = process.argv.includes("--reset");

// Get PDF paths from command line (filter out flags)
const pdfPaths = process.argv.slice(2).filter(arg => !arg.startsWith("--"));

if (pdfPaths.length === 0) {
  console.log(`
Usage: pnpm upload <pdf1> <pdf2> ... [--reset]

Examples:
  pnpm upload doc1.pdf doc2.pdf
  pnpm upload ./docs/*.pdf
  pnpm upload doc1.pdf --reset    # Clear existing data first

Options:
  --reset    Clear all existing documents before uploading
`);
  process.exit(1);
}

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.LITELLM_API_KEY,
  baseURL: process.env.LITELLM_PROXY_URL,
});

// Embedding model wrapper
let embeddingCount = 0;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const EMBED_CONCURRENCY = 5;
const VERBOSE_EMBED_LOG = false;
const embeddingCache = new Map<string, number[]>();

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
          console.log(`   [Embed #${currentCount}] ⚠️ Invalid values in embedding, retrying...`);
          throw new Error("Embedding contains invalid values (null/NaN/Infinity)");
        }

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
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }
    throw lastError;
  },
  
  async getTextEmbeddingBatch(texts: string[]): Promise<number[][]> {
    const uniqueTexts = [...new Set(texts)];
    const toCompute: string[] = [];
    let cacheHits = 0;
    for (const t of uniqueTexts) {
      if (embeddingCache.has(t)) {
        cacheHits++;
      } else {
        toCompute.push(t);
      }
    }

    if (texts.length !== uniqueTexts.length || cacheHits > 0) {
      console.log(
        `   🔁 Embedding dedup: ${texts.length} texts → ${uniqueTexts.length} unique (${cacheHits} cached, ${toCompute.length} to compute)`
      );
    }

    for (let i = 0; i < toCompute.length; i += EMBED_CONCURRENCY) {
      const batch = toCompute.slice(i, i + EMBED_CONCURRENCY);
      const embeddings = await Promise.all(batch.map((t) => this.getTextEmbedding(t)));
      batch.forEach((text, idx) => embeddingCache.set(text, embeddings[idx]));
    }

    return texts.map((t) => {
      const emb = embeddingCache.get(t);
      if (!emb) throw new Error("Embedding cache miss after batch compute");
      return emb;
    });
  },
};

// LLM client wrapper
let llmCallCount = 0;
let totalTriplets = 0;

const llmClient = {
  async structuredPredict<T>(schema: import("zod").ZodType<T>, prompt: string): Promise<T> {
    const callNum = ++llmCallCount;
    
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await openai.chat.completions.create({
          model: process.env.DEFAULT_LLM_MODEL || "gpt-4",
          messages: [
            {
              role: "system",
              content: "You are a helpful assistant that extracts structured information. Always respond with valid JSON matching the requested schema.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          response_format: { type: "json_object" },
        });
        
        const content = response.choices[0]?.message?.content || "{}";
        const parsed = JSON.parse(content);
        
        const result = schema.safeParse(parsed);
        if (result.success) {
          const tripletCount = (result.data as any).triplets?.length || 0;
          totalTriplets += tripletCount;
          return result.data;
        } else {
          return { triplets: [] } as T;
        }
      } catch (error: any) {
        lastError = error;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_DELAY_MS * attempt);
        }
      }
    }
    return { triplets: [] } as T;
  },
};

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

async function insertWithProgress(
  index: PropertyGraphIndex,
  documents: Array<{ id: string; text: string; metadata: Record<string, unknown> }>,
  batchSize: number
): Promise<any[]> {
  const total = documents.length;
  const totalBatches = Math.ceil(total / batchSize);
  const insertedAll: any[] = [];

  let runningEntities = 0;
  let runningRelations = 0;
  const overallStart = Date.now();

  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const start = batchIndex * batchSize;
    const end = Math.min(start + batchSize, total);
    const batch = documents.slice(start, end);

    console.log(`      → Batch ${batchIndex + 1}/${totalBatches}: inserting items ${start + 1}-${end}...`);
    const llmBefore = llmCallCount;
    const embedBefore = embeddingCount;
    const batchStart = Date.now();
    const insertedNodes = await index.insert(batch);
    const batchSec = ((Date.now() - batchStart) / 1000).toFixed(1);
    const llmAfter = llmCallCount;
    const embedAfter = embeddingCount;
    const llmDelta = llmAfter - llmBefore;
    const embedDelta = embedAfter - embedBefore;

    for (const node of insertedNodes) {
      runningEntities += ((node.metadata.kg_nodes as any[]) ?? []).length;
      runningRelations += ((node.metadata.kg_relations as any[]) ?? []).length;
    }

    insertedAll.push(...insertedNodes);
    console.log(
      `      ✅ Batch ${batchIndex + 1}/${totalBatches} done in ${batchSec}s | +${llmDelta} LLM calls, +${embedDelta} embeddings | running totals: ${runningEntities} entities, ${runningRelations} relations`
    );
  }

  const overallSec = ((Date.now() - overallStart) / 1000).toFixed(1);
  console.log(`      ✅ All batches complete in ${overallSec}s`);

  return insertedAll;
}

// Content item types for reading order
interface ContentItem {
  type: "text" | "image";
  content: string;        // Text content or image description
  pageNumber: number;
  y: number;              // Vertical position (top of page = 0)
  x: number;              // Horizontal position
  // Image-specific fields
  imagePath?: string;     // Local path to saved image
  imageId?: string;       // Unique ID for the image
  imageWidth?: number;
  imageHeight?: number;
  imageData?: Buffer;     // Raw image data for BLOB storage
}

interface PdfData {
  text: string;
  pages: string[];
  numPages: number;
  contentItems: ContentItem[];  // Text and images in reading order
  images: ContentItem[];        // Just the images
}

/**
 * Extract text and images from PDF using pdfjs-dist
 * Images are extracted with coordinates for proper reading order
 */
async function extractPdfContent(pdfPath: string, documentName: string): Promise<PdfData> {
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`PDF file not found: ${pdfPath}`);
  }
  
  // Dynamic import for pdfjs-dist (ESM)
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  
  const loadingTask = pdfjs.getDocument({
    data,
    standardFontDataUrl: "node_modules/pdfjs-dist/standard_fonts/",
    cMapUrl: "node_modules/pdfjs-dist/cmaps/",
    cMapPacked: true,
  });
  
  const doc = await loadingTask.promise;
  const pages: string[] = [];
  const allContentItems: ContentItem[] = [];
  const allImages: ContentItem[] = [];
  
  // Ensure output directory exists
  const docImageDir = path.join(IMAGES_OUTPUT_DIR, documentName);
  if (!fs.existsSync(docImageDir)) {
    fs.mkdirSync(docImageDir, { recursive: true });
  }
  
  console.log(`      Extracting ${doc.numPages} pages...`);
  
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.0 });
    
    // --- Extract Text with Coordinates ---
    const textContent = await page.getTextContent();
    const textItems: ContentItem[] = textContent.items.map((item: any) => {
      // PDF coordinates: (0,0) is Bottom-Left, convert to Top-Left
      const y = viewport.height - item.transform[5];
      return {
        type: "text" as const,
        content: item.str,
        pageNumber: pageNum,
        y,
        x: item.transform[4],
      };
    });
    
    // Combine text items into page text
    const pageText = textItems.map(t => t.content).join(" ");
    pages.push(pageText);
    
    // --- Extract Images ---
    const ops = await page.getOperatorList();
    const imageItems: ContentItem[] = [];
    
    // Track transformation matrix for image positions
    let currentMatrix = [1, 0, 0, 1, 0, 0];
    
    for (let j = 0; j < ops.fnArray.length; j++) {
      const fn = ops.fnArray[j];
      const args = ops.argsArray[j];
      
      // Update transform matrix
      if (fn === pdfjs.OPS.transform && args.length >= 6) {
        currentMatrix = [args[0], args[1], args[2], args[3], args[4], viewport.height - args[5]];
      }
      
      // Check for image painting operation
      if (fn === pdfjs.OPS.paintImageXObject) {
        const imgName = args[0];
        
        try {
          const imgObj = await page.objs.get(imgName);
          
          if (imgObj && imgObj.width && imgObj.height && imgObj.data) {
            const width = imgObj.width;
            const height = imgObj.height;
            
            // Skip small images (likely icons or decorations)
            if (width < MIN_IMAGE_SIZE || height < MIN_IMAGE_SIZE) continue;
            
            // Create canvas and draw image
            const canvas = createCanvas(width, height);
            const ctx = canvas.getContext("2d");
            const imgData = ctx.createImageData(width, height);
            
            // Handle different image kinds
            // kind: 1 = GRAYSCALE, 2 = RGB, 3 = RGBA
            const kind = imgObj.kind || 3;
            const srcData = imgObj.data;
            
            if (kind === 1) {
              // Grayscale to RGBA
              for (let i = 0, j = 0; i < srcData.length; i++, j += 4) {
                imgData.data[j] = srcData[i];
                imgData.data[j + 1] = srcData[i];
                imgData.data[j + 2] = srcData[i];
                imgData.data[j + 3] = 255;
              }
            } else if (kind === 2) {
              // RGB to RGBA
              for (let i = 0, j = 0; i < srcData.length; i += 3, j += 4) {
                imgData.data[j] = srcData[i];
                imgData.data[j + 1] = srcData[i + 1];
                imgData.data[j + 2] = srcData[i + 2];
                imgData.data[j + 3] = 255;
              }
            } else {
              // RGBA - direct copy
              for (let i = 0; i < srcData.length; i++) {
                imgData.data[i] = srcData[i];
              }
            }
            
            ctx.putImageData(imgData, 0, 0);
            
            // Save image to file
            const imageId = `${documentName}_p${pageNum}_${imgName}`;
            const fileName = `${imageId}.png`;
            const filePath = path.join(docImageDir, fileName);
            const buffer = canvas.toBuffer("image/png");
            fs.writeFileSync(filePath, buffer);
            
            imageItems.push({
              type: "image",
              content: "", // Will be filled with VLM description later
              pageNumber: pageNum,
              y: currentMatrix[5],
              x: currentMatrix[4],
              imagePath: filePath,
              imageId,
              imageWidth: width,
              imageHeight: height,
              imageData: buffer,
            });
          }
        } catch (e) {
          // Skip images that fail to extract
          continue;
        }
      }
    }
    
    // Merge text and images, sort by position (reading order)
    const pageContent = [...textItems, ...imageItems];
    pageContent.sort((a, b) => {
      const diffY = a.y - b.y;
      if (Math.abs(diffY) < 10) return a.x - b.x;
      return diffY;
    });
    
    allContentItems.push(...pageContent);
    allImages.push(...imageItems);
  }
  
  const fullText = pages.join("\n\n");
  
  return {
    text: fullText,
    pages,
    numPages: doc.numPages,
    contentItems: allContentItems,
    images: allImages,
  };
}

/**
 * Generate description for an image using Vision Language Model
 */
async function describeImage(imagePath: string): Promise<string> {
  const imageBuffer = fs.readFileSync(imagePath);
  const base64Image = imageBuffer.toString("base64");
  const mimeType = "image/png";
  
  const prompt = `Analyze this image in detail. If it is a diagram, explain the structure and flow. If it is a chart or graph, describe the data and trends. If it is a screenshot or photo, describe what it shows. Provide a comprehensive text description that captures all important information visible in the image.`;
  
  try {
    const response = await openai.chat.completions.create({
      model: process.env.DEFAULT_LLM_MODEL || "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`,
              },
            },
          ],
        },
      ],
      max_tokens: 500,
    });
    
    return response.choices[0]?.message?.content || "Image content could not be described.";
  } catch (error: any) {
    console.log(`      ⚠️ Failed to describe image: ${error.message}`);
    return "Image content could not be described.";
  }
}

/**
 * Create HANA table for storing image BLOBs
 */
async function createImageTable(conn: any): Promise<void> {
  try {
    await conn.exec(`
      CREATE TABLE "${IMAGE_TABLE_NAME}" (
        "IMAGE_ID" NVARCHAR(500) PRIMARY KEY,
        "DOCUMENT_ID" NVARCHAR(255),
        "PAGE_NUMBER" INTEGER,
        "IMAGE_DATA" BLOB,
        "IMAGE_PATH" NVARCHAR(1000),
        "WIDTH" INTEGER,
        "HEIGHT" INTEGER,
        "DESCRIPTION" NCLOB,
        "CREATED_AT" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log(`   ✅ Created image table: ${IMAGE_TABLE_NAME}`);
  } catch (error: any) {
    if (error.message?.includes("cannot use duplicate table name")) {
      console.log(`   ℹ️ Image table already exists: ${IMAGE_TABLE_NAME}`);
    } else {
      throw error;
    }
  }
}

/**
 * Store image in HANA BLOB table
 */
async function storeImageInHana(
  conn: any,
  imageId: string,
  documentId: string,
  pageNumber: number,
  imageData: Buffer,
  imagePath: string,
  width: number,
  height: number,
  description: string
): Promise<void> {
  try {
    await conn.exec(
      `INSERT INTO "${IMAGE_TABLE_NAME}" ("IMAGE_ID", "DOCUMENT_ID", "PAGE_NUMBER", "IMAGE_DATA", "IMAGE_PATH", "WIDTH", "HEIGHT", "DESCRIPTION")
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [imageId, documentId, pageNumber, imageData, imagePath, width, height, description]
    );
  } catch (error: any) {
    // Ignore duplicate key errors (image already exists)
    if (!error.message?.includes("unique constraint violated")) {
      console.log(`      ⚠️ Failed to store image ${imageId}: ${error.message}`);
    }
  }
}

function samplePagesForSchema(pages: string[], sampleCount: number, documentName: string): string {
  if (pages.length === 0) return "";
  
  const firstPages = pages.slice(0, Math.min(3, pages.length));
  const remainingPages = pages.slice(3);
  const randomCount = Math.max(0, sampleCount - firstPages.length);
  
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
  const sampledIndices = [
    ...firstPages.map((_, i) => i + 1),
    ...randomPages.map((_, i) => 4 + i * step),
  ];
  console.log(
    `   Sampled ${sampledPages.length} pages for schema induction from ${documentName}: pages ${sampledIndices.join(", ")}`
  );
  
  return sampledPages.join("\n\n--- Page Break ---\n\n");
}

interface DiscoveredSchema {
  entityTypes: string[];
  relationTypes: string[];
  description: string;
}

async function discoverSchema(textSamples: string[]): Promise<DiscoveredSchema> {
  console.log("\n🔬 Schema Induction: Analyzing documents to discover domain-specific schema...");
  
  // Combine samples from all documents
  const combinedSample = textSamples.join("\n\n=== DOCUMENT BREAK ===\n\n").slice(0, 30000);
  
  const inductionPrompt = `You are a Knowledge Graph schema designer. Analyze the provided text samples from MULTIPLE related documents and define an optimal schema for extracting a unified Knowledge Graph.

Constraints:
1. Identify 6-10 Entity Types that capture the main concepts across ALL documents
2. Identify 10-15 Relation Types that capture how entities relate
3. Entity types must be UPPER_SNAKE_CASE nouns
4. Relation types must be UPPER_SNAKE_CASE verbs
5. Include relations that can link concepts ACROSS documents
6. Always include "RELATED_TO" as a fallback relation type
7. Focus on relations that would help answer questions spanning multiple documents

Input Text (samples from multiple documents):
---
${combinedSample}
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
  
  if (!schema.relationTypes.includes("RELATED_TO")) {
    schema.relationTypes.push("RELATED_TO");
  }
  
  console.log(`\n   📋 Discovered Schema:`);
  console.log(`   Description: ${schema.description}`);
  console.log(`   Entity Types (${schema.entityTypes.length}): ${schema.entityTypes.join(", ")}`);
  console.log(`   Relation Types (${schema.relationTypes.length}): ${schema.relationTypes.join(", ")}`);
  
  return schema;
}

interface DocumentInfo {
  id: string;
  name: string;
  path: string;
  pages: number;
  chunks: number;
  images: number;
  entities: number;
  relations: number;
}

async function main() {
  console.log("=".repeat(70));
  console.log("  Multi-Document Upload & Knowledge Graph Extraction");
  console.log("=".repeat(70));
  console.log(`\n📚 Documents to process: ${pdfPaths.length}`);
  pdfPaths.forEach((p, i) => console.log(`   ${i + 1}. ${path.basename(p)}`));
  
  if (RESET_TABLES) {
    console.log("\n⚠️  --reset flag: Will clear existing graph data");
  }
  
  // 1. Extract text and images from all PDFs first
  console.log("\n📄 Extracting content from PDFs (text + images)...");
  const pdfDataList: Array<{ path: string; name: string; data: PdfData }> = [];
  
  for (const pdfPath of pdfPaths) {
    const name = path.basename(pdfPath, ".pdf");
    console.log(`   📄 ${name}:`);
    try {
      const data = await extractPdfContent(pdfPath, name);
      pdfDataList.push({ path: pdfPath, name, data });
      console.log(`      ✅ ${data.numPages} pages, ${data.text.length} chars, ${data.images.length} images`);
    } catch (error: any) {
      console.log(`      ❌ ${error.message}`);
    }
  }
  
  if (pdfDataList.length === 0) {
    console.error("\n❌ No valid PDFs found. Exiting.");
    process.exit(1);
  }
  
  // 2. Connect to HANA
  console.log("\n🔌 Connecting to HANA Cloud...");
  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    port: parseInt(process.env.HANA_PORT || "443"),
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });
  console.log("   ✅ Connected");
  
  // 2b. Create image BLOB table
  console.log(`\n🖼️  Setting up image storage table`);
  await createImageTable(conn);
  
  // 3. Create graph store
  console.log(`\n🗄️  Initializing graph store (graph: ${GRAPH_NAME})`);
  const graphStore = new HanaPropertyGraphStore(conn, {
    graphName: GRAPH_NAME,
    resetTables: RESET_TABLES,
  });
  
  // 4. Discover schema from ALL documents
  const textSamples = pdfDataList.map((pdf) =>
    samplePagesForSchema(pdf.data.pages, SCHEMA_SAMPLE_PAGES, pdf.name)
  );
  const schema = await discoverSchema(textSamples);
  
  // 5. Create index with unified schema
  const index = new PropertyGraphIndex({
    propertyGraphStore: graphStore,
    embedModel,
    kgExtractors: [
      new SchemaLLMPathExtractor({
        llm: llmClient,
        schema,
        maxTripletsPerChunk: TRIPLETS_PER_CHUNK,
        strict: false,
      }),
      new ImplicitPathExtractor(),
    ],
    embedKgNodes: true,
    showProgress: true,
  });
  
  // 6. Process each document
  const documentInfos: DocumentInfo[] = [];
  
  for (const pdf of pdfDataList) {
    console.log(`\n${"─".repeat(70)}`);
    console.log(`📄 Processing: ${pdf.name}`);
    console.log(`${"─".repeat(70)}`);
    
    // 6a. Process images - generate descriptions and store in HANA
    const imageCount = pdf.data.images.length;
    if (imageCount > 0) {
      console.log(`   🖼️ Processing ${imageCount} images...`);
      
      for (let i = 0; i < pdf.data.images.length; i++) {
        const img = pdf.data.images[i];
        console.log(`      [${i + 1}/${imageCount}] Describing image from page ${img.pageNumber}...`);
        
        // Generate description using VLM
        const description = await describeImage(img.imagePath!);
        img.content = description;
        
        // Store image in HANA BLOB table
        await storeImageInHana(
          conn,
          img.imageId!,
          pdf.name,
          img.pageNumber,
          img.imageData!,
          img.imagePath!,
          img.imageWidth!,
          img.imageHeight!,
          description
        );
      }
      console.log(`   ✅ Processed ${imageCount} images`);
    }
    
    // 6b. Chunk the document text
    const chunks = chunkText(pdf.data.text, CHUNK_SIZE, CHUNK_OVERLAP);
    console.log(`   📝 Text chunks: ${chunks.length}`);
    
    // 6c. Prepare text documents with metadata (including page number estimation)
    const documents: Array<{ id: string; text: string; metadata: Record<string, unknown> }> = chunks.map((chunk, idx) => {
      // Estimate page number based on chunk position
      const estimatedPage = Math.min(
        Math.floor((idx / chunks.length) * pdf.data.numPages) + 1,
        pdf.data.numPages
      );
      
      return {
        id: `${pdf.name}_chunk_${idx}`,
        text: chunk,
        metadata: {
          documentId: pdf.name,
          documentPath: pdf.path,
          documentPages: pdf.data.numPages,
          pageNumber: estimatedPage,
          chunkIndex: idx,
          totalChunks: chunks.length,
          contentType: "text",
        },
      };
    });
    
    // 6d. Create image description documents (these become searchable chunks)
    const imageDocuments: Array<{ id: string; text: string; metadata: Record<string, unknown> }> = pdf.data.images.map((img, idx) => ({
      id: `${pdf.name}_image_${idx}`,
      text: `[Image on page ${img.pageNumber}]\n${img.content}`,
      metadata: {
        documentId: pdf.name,
        documentPath: pdf.path,
        documentPages: pdf.data.numPages,
        pageNumber: img.pageNumber,
        contentType: "image",
        imageId: img.imageId,
        imagePath: img.imagePath,
        imageWidth: img.imageWidth,
        imageHeight: img.imageHeight,
      },
    }));
    
    // 6e. Combine text and image documents
    const allDocuments: Array<{ id: string; text: string; metadata: Record<string, unknown> }> = [...documents, ...imageDocuments];
    
    // Insert and extract
    console.log(`   📤 Inserting ${allDocuments.length} items (${documents.length} text + ${imageDocuments.length} image)...`);
    const startTime = Date.now();
    const insertedNodes = await insertWithProgress(index, allDocuments, 10);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    
    // Count entities and relations
    let docEntities = 0;
    let docRelations = 0;
    for (const node of insertedNodes) {
      docEntities += ((node.metadata.kg_nodes as any[]) ?? []).length;
      docRelations += ((node.metadata.kg_relations as any[]) ?? []).length;
    }
    
    console.log(`   ✅ Done in ${duration}s: ${docEntities} entities, ${docRelations} relations`);
    
    documentInfos.push({
      id: pdf.name,
      name: pdf.name,
      path: pdf.path,
      pages: pdf.data.numPages,
      chunks: chunks.length,
      images: imageCount,
      entities: docEntities,
      relations: docRelations,
    });
  }
  
  // 7. Summary
  console.log("\n" + "=".repeat(70));
  console.log("📊 Upload Summary");
  console.log("=".repeat(70));
  
  console.log("\n📚 Documents uploaded:");
  for (const doc of documentInfos) {
    console.log(`   • ${doc.name}`);
    console.log(`     Pages: ${doc.pages}, Chunks: ${doc.chunks}, Images: ${doc.images}`);
    console.log(`     Entities: ${doc.entities}, Relations: ${doc.relations}`);
  }
  
  const totalEntities = documentInfos.reduce((sum, d) => sum + d.entities, 0);
  const totalRelations = documentInfos.reduce((sum, d) => sum + d.relations, 0);
  const totalChunks = documentInfos.reduce((sum, d) => sum + d.chunks, 0);
  const totalImages = documentInfos.reduce((sum, d) => sum + d.images, 0);
  
  console.log(`\n📈 Totals:`);
  console.log(`   Documents: ${documentInfos.length}`);
  console.log(`   Chunks: ${totalChunks}`);
  console.log(`   Images: ${totalImages}`);
  console.log(`   Entities: ${totalEntities}`);
  console.log(`   Relations: ${totalRelations}`);
  
  console.log("\n" + "=".repeat(70));
  console.log("✅ Upload complete! Run 'pnpm chat' to query across all documents.");
  console.log("=".repeat(70) + "\n");
  
  process.exit(0);
}

main().catch((error) => {
  console.error("\n❌ Error:", error.message);
  process.exit(1);
});
