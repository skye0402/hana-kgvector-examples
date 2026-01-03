# PDF Chat Example

This example demonstrates how to build a PDF document Q&A system using `hana-kgvector`. It shows:

1. **PDF Upload**: Extract text from PDFs, chunk it, and build a knowledge graph
2. **Chat Interface**: Query documents using natural language with GraphRAG retrieval

## Features

- 📄 **PDF text extraction** with automatic chunking
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

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env`:

```env
# SAP HANA Cloud
HANA_HOST=your-instance.hanacloud.ondemand.com
HANA_PORT=443
HANA_USER=your-username
HANA_PASSWORD=your-password

# LLM API (LiteLLM proxy or OpenAI)
LITELLM_API_BASE=http://localhost:4000
LITELLM_API_KEY=your-api-key

# Models
EMBEDDING_MODEL=text-embedding-3-small
LLM_MODEL=gpt-4
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
1. Extracts text from the PDF
2. Chunks text into manageable segments (1000 chars with 200 char overlap)
3. Connects to HANA Cloud
4. Extracts entities (PERSON, ORGANIZATION, LOCATION, etc.) and relations using LLM
5. Stores everything in HANA (vectors + RDF knowledge graph)

**Example output:**
```
📄 Loading PDF: sample.pdf
   Pages: 10
   Text length: 15234 characters

✂️  Chunking text (size: 1000, overlap: 200)
   Created 18 chunks

🚀 Inserting 18 chunks and extracting knowledge graph...

✅ Insertion complete in 45.2s
   Processed 18 document chunks

📊 Extraction Statistics:
   Total entities extracted: 87
   Total relations extracted: 134
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

### Query Process

```typescript
// 1. Query the knowledge graph
const results = await index.query(userQuestion, {
  similarityTopK: 5,      // Top 5 similar entities
  pathDepth: 2,           // Traverse 2 hops in graph
  limit: 30,              // Max 30 results
  crossCheckBoost: true,  // Boost provenance-linked facts
});

// 2. Generate AI response using retrieved context
const response = await generateResponse(userQuestion, results);
```

## Customization

### Adjust Chunking

Edit `upload-pdf.ts`:

```typescript
const CHUNK_SIZE = 1500;    // Larger chunks = more context
const CHUNK_OVERLAP = 300;  // More overlap = better continuity
```

### Modify Entity Schema

Edit the schema in `upload-pdf.ts` to extract domain-specific entities:

```typescript
const schema = {
  entityTypes: ["DISEASE", "DRUG", "SYMPTOM", "TREATMENT"],
  relationTypes: ["TREATS", "CAUSES", "PREVENTS"],
  validationSchema: [
    ["DRUG", "TREATS", "DISEASE"],
    ["DISEASE", "CAUSES", "SYMPTOM"],
  ],
};
```

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

- Verify `LITELLM_API_BASE` and `LITELLM_API_KEY`
- Test with: `curl $LITELLM_API_BASE/v1/models`
- Ensure model names match your LiteLLM configuration

### "No results found"

- First upload a PDF: `pnpm upload`
- Check that the graph name matches (`pdf_documents`)
- Try broader queries or adjust `similarityTopK`

### "Extraction is slow"

- Reduce chunk count by increasing `CHUNK_SIZE`
- Reduce `maxTripletsPerChunk` in schema extractor
- Use a faster LLM model

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
