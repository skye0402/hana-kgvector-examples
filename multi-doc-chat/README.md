# Multi-Document Chat Example with Image Processing

This example demonstrates how to build a **multi-document Q&A system** using `hana-kgvector`. Upload multiple related PDFs and query across all of them with a unified knowledge graph. **Images in PDFs are automatically extracted, described by a Vision LLM, and made searchable.**

## Features

- 📚 **Multi-document upload**: Process multiple PDFs into a single knowledge graph
- 🖼️ **Image processing**: Extract images from PDFs, generate descriptions using VLM
- 🔬 **Unified schema induction**: Discover entity/relation types across ALL documents
- 🔍 **Cross-document queries**: Ask questions that span multiple documents (including image content)
- 📋 **Document filtering**: Focus queries on specific document(s)
- 🔄 **Compare command**: Compare how different documents discuss a topic
- 📊 **Source attribution**: See which documents and pages contributed to each answer
- 💾 **Image storage**: Images stored in HANA BLOB table with metadata linking

## Use Cases

- **Technical documentation**: Query across multiple product manuals
- **Research papers**: Compare findings across related papers
- **Legal documents**: Search across contracts, policies, and regulations
- **Company reports**: Analyze multiple quarterly/annual reports

## Prerequisites

1. **SAP HANA Cloud** instance with KG + Vector engines enabled
2. **LLM API** (OpenAI or LiteLLM proxy)
3. **Multiple PDF documents** on a related topic

## Setup

```bash
cd multi-doc-chat
pnpm install
```

Create `.env.local` from the example template:

```bash
cp .env.example .env.local
# Edit .env.local with your credentials
```

Required environment variables:

```env
# SAP HANA Cloud Connection
HANA_HOST=your-instance.hanacloud.ondemand.com
HANA_PORT=443
HANA_USER=your-username
HANA_PASSWORD=your-password

# LLM API Configuration
LITELLM_PROXY_URL=http://localhost:4000
LITELLM_API_KEY=your-api-key

# Model Configuration
DEFAULT_EMBEDDING_MODEL=text-embedding-3-small
DEFAULT_LLM_MODEL=gpt-4

# Optional: Custom graph name (default: MULTI_DOC_GRAPH)
# GRAPH_NAME=MULTI_DOC_GRAPH
```

## Usage

### Step 1: Upload Multiple Documents

```bash
# Upload multiple PDFs at once
pnpm upload doc1.pdf doc2.pdf doc3.pdf

# Upload all PDFs in a directory
pnpm upload ./docs/*.pdf

# Clear existing data and upload fresh
pnpm upload doc1.pdf doc2.pdf --reset

# Faster upload (skip image extraction + VLM)
pnpm upload doc1.pdf doc2.pdf --no-images
```

**What happens:**
1. Extracts text AND images from ALL PDFs using `pdfjs-dist`
2. **Image processing**: Each image is sent to a Vision LLM to generate a text description
3. **Unified schema induction**: Analyzes samples from ALL documents to discover entity/relation types
4. Processes each document with the unified schema
5. Stores text chunks AND image descriptions in the knowledge graph
6. Stores original images in a separate HANA BLOB table for future retrieval

**Example output:**
```
📚 Documents to process: 3
   1. product-guide.pdf
   2. installation-manual.pdf
   3. troubleshooting.pdf

📄 Extracting content from PDFs (text + images)...
   📄 product-guide:
      Extracting 24 pages...
      ✅ 24 pages, 45234 chars, 5 images
   📄 installation-manual:
      Extracting 12 pages...
      ✅ 12 pages, 23456 chars, 3 images
   📄 troubleshooting:
      Extracting 8 pages...
      ✅ 8 pages, 15678 chars, 2 images

🖼️  Setting up image storage table
   ✅ Created image table: multi_doc_graph_IMAGES

🔬 Schema Induction: Analyzing documents to discover domain-specific schema...

   📋 Discovered Schema:
   Description: Technical product documentation covering features, installation, and troubleshooting
   Entity Types (8): PRODUCT, COMPONENT, FEATURE, PROCEDURE, ERROR, SOLUTION, REQUIREMENT, CONFIGURATION
   Relation Types (12): HAS_FEATURE, REQUIRES, CAUSES, RESOLVES, PART_OF, DEPENDS_ON, ...

──────────────────────────────────────────────────────────────────────
📄 Processing: product-guide
──────────────────────────────────────────────────────────────────────
   🖼️ Processing 5 images...
      [1/5] Describing image from page 3...
      [2/5] Describing image from page 7...
      ...
   ✅ Processed 5 images
   📝 Text chunks: 52
   📤 Inserting 57 items (52 text + 5 image)...
   ✅ Done in 65.2s: 187 entities, 234 relations

📊 Upload Summary
   Documents: 3
   Chunks: 102
   Images: 10
   Entities: 342
   Relations: 456
```

### Step 2: List Uploaded Documents

```bash
pnpm list
```

Shows all documents currently in the knowledge graph.

### Step 3: Chat Across Documents

```bash
pnpm chat
```

**Example conversation:**
```
You: What are the system requirements?

🔍 Searching...
   Found 15 relevant passages
   Spanning 2 documents: product-guide, installation-manual

🤖 Assistant: 
Based on the documentation, the system requirements are:

From the **product-guide**: The software requires Windows 10 or later, 
8GB RAM minimum (16GB recommended), and 500MB disk space.

From the **installation-manual**: Additionally, you need .NET Framework 4.8 
and administrator privileges for installation.

📚 Sources:
   • product-guide: 8 passages
   • installation-manual: 7 passages
```

### Chat Commands

| Command | Description |
|---------|-------------|
| `filter <doc1> <doc2>` | Filter queries to specific documents |
| `filter clear` | Clear filter (query all documents) |
| `filter` | Show current filter |
| `compare <topic>` | Compare how documents discuss a topic |
| `sources` | Show document sources from last query |
| `help` | Show all commands |
| `exit` | Exit the chat |

### Document Filtering

Focus your queries on specific documents:

```
You: filter installation-manual
✅ Filter set to: installation-manual

You [filter: installation-manual]: How do I install?

🔍 Searching...
   Found 8 passages (filtered to: installation-manual)

🤖 Assistant: ...

You: filter clear
✅ Filter cleared - now querying all documents
```

### Compare Documents

Compare how different documents discuss a topic:

```
You: compare error handling

🔍 Comparing across documents...
   Found 12 relevant passages from 2 documents

🤖 Assistant:
The documents approach error handling differently:

**product-guide** focuses on user-facing error messages and their meanings,
providing a reference table of error codes.

**troubleshooting** provides step-by-step resolution procedures for each
error, including diagnostic commands and escalation paths.

Both documents reference the same error codes but serve different purposes:
one for understanding, one for resolution.

📚 Sources:
   • product-guide: 5 passages
   • troubleshooting: 7 passages
```

## How It Works

### Unified Schema Induction

Unlike single-document processing, multi-document upload:

1. **Samples from ALL documents** before schema induction
2. **Discovers entity/relation types** that work across the entire corpus
3. **Enables cross-document relationships** in the knowledge graph

This means entities like "Product X" mentioned in multiple documents will be recognized as the same entity, enabling queries that span documents.

### Image Processing Pipeline

The "Describe & Embed" approach for handling images:

1. **Extraction**: `pdfjs-dist` extracts images with their page coordinates
2. **Filtering**: Small images (<100x100px) are skipped (likely icons/noise)
3. **Description**: Each image is sent to a Vision LLM (e.g., GPT-4o) to generate a text description
4. **Embedding**: The text description is embedded like any other text chunk
5. **Storage**: 
   - Description stored in knowledge graph (searchable)
   - Original image stored in HANA BLOB table (for future display)

This means you can search for "architecture diagram" or "flowchart showing the process" and find relevant images even though you're searching text.

### Structural Adjacency Linking (v0.1.8+)

Images and other multimodal content are made retrievable through **structural graph edges** that link chunks based on document position:

1. **`ON_SAME_PAGE`**: Links chunks that share the same page number
2. **`ADJACENT_TO`**: Links sequential chunks by their position in the document

**How it works:**
- During upload, `AdjacencyLinker` creates structural relations between CHUNK nodes
- During query, the retriever traverses these edges after finding matched entities
- If a query matches text near an image, the image chunk is pulled in via structural traversal

**Example:**
```
Query: "What is the S/4HANA migration process?"
       │
       ▼
1. Vector search finds entities: PRODUCT_S4HANA, FEATURE_MIGRATION
2. Semantic expansion finds related entities
3. Source chunks retrieved via TRIPLET_SOURCE_KEY
4. Structural expansion follows ON_SAME_PAGE → finds image chunk on same page
5. Image description included in results (with imageId for display)
```

**Configuration in upload-docs.ts:**
```typescript
new AdjacencyLinker({
  linkSamePage: true,      // Link chunks on the same page
  linkAdjacent: true,      // Link sequential chunks
  adjacentDistance: 2,     // Include neighbors up to 2 hops away (better text↔image bridging)
  crossTypeOnly: false,    // Link all chunks (set true for only text↔image)
})
```

**Verifying triples / relations in HANA:**

Triples for relations (including structural edges) are stored in the named graph `<${GRAPH_NAME}>`. To inspect them, use `SPARQL_TABLE(...)` (as used internally by `hana-kgvector`), for example:

```sql
SELECT * FROM SPARQL_TABLE('
  SELECT (COUNT(*) AS ?cnt)
  FROM <MULTI_DOC_GRAPH>
  WHERE { ?s ?p ?o . }
');
```

**Configuration in chat.ts:**
```typescript
const results = await index.query(query, {
  includeStructuralEdges: true,  // Enable structural traversal
  structuralDepth: 1,            // How deep to traverse structural edges
});
```

### Document Metadata

Each chunk is tagged with document-level metadata:

```typescript
// Text chunk metadata
{
  documentId: "product-guide",
  documentPath: "./docs/product-guide.pdf",
  documentPages: 24,
  pageNumber: 5,           // Actual page number
  chunkIndex: 5,
  totalChunks: 52,
  contentType: "text",
}

// Image chunk metadata
{
  documentId: "product-guide",
  documentPath: "./docs/product-guide.pdf",
  documentPages: 24,
  pageNumber: 7,
  contentType: "image",
  imageId: "product-guide_p7_img_X1",
  imagePath: "./extracted_images/product-guide/...",
  imageWidth: 800,
  imageHeight: 600,
}
```

This enables:
- Filtering queries to specific documents
- Attributing answers to source documents and pages
- Distinguishing text vs image sources in answers
- Linking to original images for display

### Cross-Document Queries

The KG-RAG retrieval naturally finds related information across documents because:

1. **Vector search** finds similar content regardless of source document
2. **Graph expansion** follows relationships that may span documents
3. **Cross-check boosting** prioritizes coherent information

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                Multi-Document Chat with Images                │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│  upload-docs.ts                   chat.ts                     │
│  ┌────────────────────────┐        ┌──────────────────────┐   │
│  │ Extract text+images    │        │ Query all/filtered   │   │
│  │ VLM image descriptions │        │ Text + image results │   │
│  │ Unified schema         │        │ Page attribution     │   │
│  │ Store in KG + BLOB     │        │ Source tracking      │   │
│  └────────────────────────┘        └──────────────────────┘   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────┐
│                    SAP HANA Cloud                             │
│                                                               │
│  Knowledge Graph (multi_doc_graph)                            │
│  ├── Text chunks with page numbers                            │
│  ├── Image descriptions (searchable)                          │
│  └── Cross-document entity resolution                         │
│                                                               │
│  Image BLOB Table (multi_doc_graph_IMAGES)                    │
│  ├── IMAGE_ID, DOCUMENT_ID, PAGE_NUMBER                       │
│  ├── IMAGE_DATA (BLOB), IMAGE_PATH                            │
│  └── WIDTH, HEIGHT, DESCRIPTION                               │
└───────────────────────────────────────────────────────────────┘
```

## Customization

### Change Graph Name

Set `GRAPH_NAME` in `.env.local`.

Graph names are case-sensitive in HANA/SPARQL. Ensure the same value is used for upload + chat + list.

```typescript
GRAPH_NAME=my_custom_graph
```

### Adjust Chunking

```typescript
const CHUNK_SIZE = 1500;    // Larger chunks
const CHUNK_OVERLAP = 200;  // More overlap
```

### Tune Schema Induction

```typescript
const SCHEMA_SAMPLE_PAGES = 8;  // More pages per document
```

### Image Processing Settings

```typescript
const MIN_IMAGE_SIZE = 100;              // Skip images smaller than 100x100
const IMAGES_OUTPUT_DIR = "./images";    // Where to save extracted images
```

To disable image processing entirely, you can filter out images before processing.

## Troubleshooting

### "No documents found"

- Run `pnpm upload` first with your PDF files
- Check that PDFs are readable and contain text

### "Filter returns no results"

- Use `pnpm list` to see exact document names
- Filter matching is case-insensitive and partial

### "Cross-document entities not linked"

- Ensure documents use consistent terminology
- The unified schema helps, but entity resolution depends on LLM extraction

## Diagnostic Tools

The `tools/` directory contains helpful scripts for debugging and inspecting your knowledge graph:

| Tool | Description |
|------|-------------|
| `pnpm inspect` | Inspect HANA tables (_NODES, _VECTORS, _IMAGES) |
| `tsx tools/query-sparql.ts` | Query RDF graph directly, view structural relations |
| `tsx tools/check-relations.ts` | Check entity and relation counts |
| `tsx tools/list-tables.ts` | List all graph-related tables |

**Example:**
```bash
# Inspect the vectors table
pnpm inspect --table vectors --limit 10

# Check structural edge counts
tsx tools/query-sparql.ts
```

## Related Examples

- **[Graph Visualizer](../graph-visualizer)**: Interactive web UI to visualize the knowledge graph and query results with image display
- **[PDF Chat](../pdf-chat)**: Simpler single-document example without image processing

## Next Steps

- **Add document versioning**: Track document versions and updates
- **Implement incremental upload**: Add documents without re-processing existing ones
- **Add document similarity**: Find similar documents in the corpus
