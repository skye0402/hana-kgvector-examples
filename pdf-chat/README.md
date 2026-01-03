# PDF Chat Example

This example demonstrates how to build a PDF document Q&A system using `hana-kgvector`. It shows:

1. **PDF Upload**: Extract text from PDFs, chunk it, and build a knowledge graph
2. **Chat Interface**: Query documents using natural language with GraphRAG retrieval

## Features

- 📄 **PDF text extraction** with automatic chunking
- 🔬 **Schema Induction** - automatically discovers domain-specific entity/relation types
- 🧠 **Knowledge graph extraction** using LLM (entities, relations)
- 🔍 **Hybrid retrieval** combining vector search + graph traversal
- 💬 **Interactive chat** with AI-generated responses
- 📊 **Cross-check boosting** for improved relevance

## Prerequisites

1. **SAP HANA Cloud** instance with:
   - Knowledge Graph Engine enabled
   - Vector Engine enabled

2. **LLM API** (one of):
   - OpenAI API key
   - LiteLLM proxy (recommended for SAP GenAI Hub)
   - Any OpenAI-compatible endpoint

## Setup

### 1. Install Dependencies

```bash
cd examples/pdf-chat
pnpm install
# or: npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env.local` and fill in your credentials:

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
# SAP HANA Cloud
HANA_HOST=your-instance.hanacloud.ondemand.com
HANA_PORT=443
HANA_USER=your-username
HANA_PASSWORD=your-password

# LLM API (LiteLLM proxy or OpenAI)
LITELLM_PROXY_URL=http://localhost:4000
LITELLM_API_KEY=your-api-key

# Models
DEFAULT_EMBEDDING_MODEL=text-embedding-3-small
DEFAULT_LLM_MODEL=gpt-4
```

### 3. Prepare a PDF

Place a PDF file in this directory, or use the path to any PDF:

```bash
# Example: download a sample PDF
curl -o sample.pdf https://www.example.com/document.pdf
```

## Usage

### Step 1: Upload PDF

Upload and process a PDF document:

```bash
pnpm upload
# or specify a custom PDF path:
pnpm upload /path/to/your/document.pdf
```

**What happens:**
1. Extracts text from the PDF with page-level access
2. Chunks text into manageable segments (1000 chars with 100 char overlap)
3. **Schema Induction**: Samples pages from throughout the document (first 3 + evenly-distributed pages) to discover domain-specific entity and relation types
4. Connects to HANA Cloud
5. Extracts entities and relations using the discovered schema
6. Embeds KG nodes for vector similarity search
7. Stores everything in HANA (vectors + RDF knowledge graph)

**Example output:**
```
📄 Loading PDF: sample.pdf
   Pages: 24
   Text length: 45234 characters

✂️  Chunking text (size: 1000, overlap: 100)
   Created 52 chunks

🔬 Schema Induction: Analyzing document to discover domain-specific schema...
   Sampled 6 pages for schema induction: pages 1, 2, 3, 10, 17, 24

   📋 Discovered Schema:
   Description: Technical documentation about SAP S/4HANA transition
   Entity Types (7): ORGANIZATION, PRODUCT, SERVICE, TECHNOLOGY, FEATURE, CONCEPT, PROCESS
   Relation Types (11): PROVIDES, USES, INTEGRATES_WITH, SUPPORTS, ENABLES, PART_OF, DEPENDS_ON, REQUIRES, INCLUDES, REPLACES, RELATED_TO

🚀 Inserting 52 chunks and extracting knowledge graph...
   [LLM #1] Extracting entities...
   [LLM #1] ✅ 8 triplets extracted (total: 8)
   ...
   [Embed] Processing 156 texts → 142 unique (14 duplicates)
   [Embed] ✅ Completed 142 embeddings in 12.3s

✅ Insertion complete in 45.2s
   Processed 52 document chunks

📊 Extraction Statistics:
   Total entities extracted: 187
   Total relations extracted: 234
   Average entities per chunk: 3.6
   Average relations per chunk: 4.5
```

### Step 2: Chat with Your Document

Start an interactive chat session:

```bash
pnpm chat
```

**Example conversation:**
```
You: What is this document about?

🔍 Searching...
   Found 12 relevant passages

🤖 Assistant: 
This document discusses the implementation of GraphRAG systems 
using SAP HANA Cloud. It covers hybrid retrieval approaches that 
combine vector similarity search with knowledge graph traversal...

📚 Sources:
   - sample

You: Who are the key people mentioned?

🤖 Assistant:
The document mentions several key people including Tim Cook (CEO 
of Apple), Satya Nadella (Microsoft CEO), and references to 
researchers in the GraphRAG field...
```

**Chat commands:**
- Type your question and press Enter
- `help` - Show available commands
- `exit` or `quit` - Exit the chat
- `explain <question>` - Show KG-RAG retrieval internals (vector matches, triplets, boosting)
- `explain-last` - Re-explain the previous question
- `auto-explain` - Toggle automatic debug output for every question

## How It Works

### Upload Process

```typescript
// 1. Extract PDF text
const pdfText = await extractPdfText(PDF_PATH);

// 2. Chunk into segments
const chunks = chunkText(pdfText, CHUNK_SIZE, CHUNK_OVERLAP);

// 3. Create PropertyGraphIndex with schema
const index = new PropertyGraphIndex({
  propertyGraphStore: graphStore,
  embedModel,
  kgExtractors: [
    new SchemaLLMPathExtractor({
      llm: llmClient,
      schema: {
        entityTypes: ["PERSON", "ORGANIZATION", "LOCATION", ...],
        relationTypes: ["WORKS_AT", "LOCATED_IN", ...],
      },
    }),
    new ImplicitPathExtractor(),
  ],
});

// 4. Insert documents (extracts KG + stores vectors)
await index.insert(documents);
```

### Query Process (KG-RAG)

The chat uses a hybrid **Knowledge Graph RAG** (KG-RAG) approach that combines vector similarity with graph traversal:

```typescript
// 1. Query the knowledge graph
const results = await index.query(userQuestion, {
  similarityTopK: 5,           // Top 5 similar KG nodes via vector search
  pathDepth: 2,                // Traverse 2 hops in the graph
  limit: 30,                   // Max 30 results
  crossCheckBoost: true,       // Boost provenance-linked facts
  crossCheckBoostFactor: 1.25, // Boost multiplier
});

// 2. Generate AI response using retrieved context
const response = await generateResponse(userQuestion, results);
```

**How KG-RAG retrieval works:**
1. **Vector Search**: Embed the query and find similar KG nodes (entities)
2. **Graph Expansion**: Traverse the knowledge graph from matched nodes to find related triplets
3. **Cross-Check Boosting**: Boost triplets that share provenance (same source document/chunk) with vector-matched nodes
4. **Context Building**: Combine semantic triplets + original chunk text for LLM context
5. **Response Generation**: LLM answers based on the enriched context

Use `explain <question>` in chat to see this process in detail.

## Customization

### Schema Induction Settings

The upload script automatically discovers domain-specific entity and relation types by analyzing a sample of your document. Configure this behavior in `upload-pdf.ts`:

```typescript
// Configuration
const SCHEMA_SAMPLE_PAGES = 6;      // Number of pages to sample for schema induction
const AUTO_DISCOVER_SCHEMA = true;  // Set to false to use hardcoded schema
const HUMAN_REVIEW = false;         // Set to true to prompt for schema approval
const RESET_TABLES = true;          // Clear existing graph data before upload
const TRIPLETS_PER_CHUNK = 100;     // High value for natural extraction (not a hard cap)
```

| Setting | Default | Description |
|---------|---------|-------------|
| `AUTO_DISCOVER_SCHEMA` | `true` | Enable automatic schema discovery from document |
| `HUMAN_REVIEW` | `false` | Prompt user to approve discovered schema |
| `SCHEMA_SAMPLE_PAGES` | `6` | Number of pages to sample (first 3 + distributed) |
| `RESET_TABLES` | `true` | Drop existing graph tables before upload |
| `TRIPLETS_PER_CHUNK` | `100` | Hint to LLM for max triplets per chunk |

**How Schema Induction works:**
1. Samples pages from throughout your document (first 3 pages + evenly-distributed pages from the rest)
2. Sends the sample to the LLM with a specialized prompt
3. LLM analyzes the content and proposes domain-specific entity/relation types
4. Schema is used for the actual knowledge graph extraction

**Benefits:**
- **Domain-agnostic**: Works for legal, medical, technical, financial documents
- **No manual configuration**: Schema adapts to your document's content
- **Better extraction quality**: Relations match the actual document vocabulary

### Adjust Chunking

Edit `upload-pdf.ts`:

```typescript
const CHUNK_SIZE = 1500;    // Larger chunks = more context
const CHUNK_OVERLAP = 300;  // More overlap = better continuity
```

### Modify Entity Schema

The default schema includes comprehensive relation types for general business/technical documents:

```typescript
const schema = {
  entityTypes: [
    "PERSON", "ORGANIZATION", "LOCATION", "PRODUCT",
    "SERVICE", "TECHNOLOGY", "CONCEPT", "EVENT", "DATE", "DOCUMENT"
  ],
  relationTypes: [
    // Employment & Roles
    "WORKS_AT", "LEADS", "MANAGES", "REPORTS_TO", "FOUNDED_BY",
    // Location & Geography
    "LOCATED_IN", "HEADQUARTERED_IN", "OPERATES_IN",
    // Products & Services
    "PRODUCES", "PROVIDES", "OFFERS", "USES", "REQUIRES",
    // Relationships & Structure
    "PART_OF", "CONTAINS", "BELONGS_TO", "SUBSIDIARY_OF", "PARTNER_OF", "COMPETES_WITH",
    // Actions & Events
    "ACQUIRED", "MERGED_WITH", "INVESTED_IN", "LAUNCHED", "ANNOUNCED",
    // Technical & Functional
    "SUPPORTS", "ENABLES", "INTEGRATES_WITH", "DEPENDS_ON", "IMPLEMENTS", "EXTENDS",
    // Temporal
    "OCCURRED_ON", "STARTED_ON", "ENDED_ON",
    // Generic fallback
    "RELATED_TO"
  ],
};
```

**For domain-specific use cases**, customize the schema:

```typescript
// Medical domain
const medicalSchema = {
  entityTypes: ["DISEASE", "DRUG", "SYMPTOM", "TREATMENT", "BODY_PART", "PROCEDURE"],
  relationTypes: ["TREATS", "CAUSES", "PREVENTS", "DIAGNOSES", "CONTRAINDICATES", "RELATED_TO"],
};

// Legal domain
const legalSchema = {
  entityTypes: ["PARTY", "CONTRACT", "CLAUSE", "OBLIGATION", "RIGHT", "JURISDICTION"],
  relationTypes: ["BINDS", "GRANTS", "RESTRICTS", "GOVERNS", "REFERENCES", "RELATED_TO"],
};

// Automotive domain
const automotiveSchema = {
  entityTypes: ["VEHICLE", "COMPONENT", "MANUFACTURER", "STANDARD", "FEATURE", "SYSTEM"],
  relationTypes: ["MANUFACTURES", "CONTAINS", "COMPLIES_WITH", "INTEGRATES", "RELATED_TO"],
};
```

**Important**: Always include `RELATED_TO` as a fallback relation type. The LLM may generate relations not in your schema; with `strict: false`, unknown relations are dropped gracefully rather than causing errors.

### Tune Retrieval Parameters

Edit `chat.ts` query options:

```typescript
const results = await index.query(query, {
  similarityTopK: 10,        // More initial matches
  pathDepth: 3,              // Deeper graph traversal
  limit: 50,                 // More results
  crossCheckBoostFactor: 1.5, // Stronger provenance boost
});
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     PDF Chat Application                     │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  upload-pdf.ts                    chat.ts                    │
│  ┌──────────────┐                ┌──────────────┐           │
│  │ PDF Extract  │                │ User Query   │           │
│  │ Text Chunk   │                │ Vector Search│           │
│  │ KG Extract   │                │ Graph Expand │           │
│  │ Store HANA   │                │ AI Response  │           │
│  └──────────────┘                └──────────────┘           │
│         │                                │                   │
└─────────┼────────────────────────────────┼───────────────────┘
          │                                │
          ▼                                ▼
┌─────────────────────────────────────────────────────────────┐
│                    hana-kgvector Library                     │
├─────────────────────────────────────────────────────────────┤
│  PropertyGraphIndex  │  VectorContextRetriever              │
│  SchemaLLMPathExtractor  │  HanaPropertyGraphStore          │
└─────────────────────────────────────────────────────────────┘
          │                                │
          ▼                                ▼
┌─────────────────────────────────────────────────────────────┐
│                    SAP HANA Cloud                            │
├─────────────────────────────────────────────────────────────┤
│  Knowledge Graph Engine (RDF)  │  Vector Engine (REAL_VECTOR)│
└─────────────────────────────────────────────────────────────┘
```

## Troubleshooting

### "Cannot connect to HANA"

- Verify HANA credentials in `.env`
- Check that your HANA instance has KG + Vector engines enabled
- Ensure network connectivity (VPN if required)

### "Embedding API returns errors"

- Verify `LITELLM_PROXY_URL` and `LITELLM_API_KEY`
- Test with: `curl $LITELLM_PROXY_URL/v1/models`
- Ensure model names match your LiteLLM configuration
- Check that `DEFAULT_EMBEDDING_MODEL` is a valid embedding model

### "No results found"

- First upload a PDF: `pnpm upload`
- Check that the graph name matches (`pdf_documents`)
- Try broader queries or adjust `similarityTopK`

### "Extraction is slow"

- Reduce chunk count by increasing `CHUNK_SIZE`
- Reduce `TRIPLETS_PER_CHUNK` (but keep it high enough for quality)
- Use a faster LLM model
- Embeddings run in parallel with deduplication

### "Answers don't use the document content"

- Use `explain <question>` to see what's being retrieved
- Check that triplets are being extracted (see upload stats)
- Increase `pathDepth` to traverse more graph connections
- Increase `similarityTopK` for more vector matches
- Check that the schema matches your document's domain

## Next Steps

- **Multi-document support**: Modify to handle multiple PDFs with different `documentId`
- **Web interface**: Build a React/Next.js frontend
- **Advanced RAG**: Add re-ranking, query expansion, or hybrid fusion
- **Domain-specific schemas**: Customize entity types for your use case

## Learn More

- [hana-kgvector Documentation](../../README.md)
- [Tutorial](../../TUTORIAL.md)
- [SAP HANA Cloud Vector Engine](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-vector-engine-guide)
- [SAP HANA Cloud Knowledge Graph](https://help.sap.com/docs/hana-cloud-database/sap-hana-cloud-sap-hana-database-graph-reference)
