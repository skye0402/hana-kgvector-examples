# KG-RAG Graph Visualizer

Interactive visualization of Knowledge Graph RAG retrieval. Query your documents and see the knowledge graph come alive.

## Features

- 🔍 **Query Interface**: Ask questions about your uploaded documents
- 🤖 **AI Answers**: Get responses powered by KG-RAG retrieval
- 🕸️ **Graph Visualization**: See the knowledge graph with:
  - Vector-matched nodes (highlighted in yellow)
  - Entity relationships as edges
  - Color-coded entity types
  - Interactive zoom, pan, and drag
- 🖼️ **Image Display**: View images found in context with thumbnails
- 📊 **Retrieval Stats**: View vector matches, triplet counts, image counts, and more

## Prerequisites

1. **Uploaded documents**: Run `pnpm upload` in the `multi-doc-chat` folder first
2. **Environment configured**: The `.env.local` file in `multi-doc-chat` with HANA and LLM credentials

## Setup

```bash
cd graph-visualizer
pnpm install
```

## Usage

Start both the backend server and frontend:

```bash
pnpm dev
```

This runs:
- **Backend** at http://localhost:3001 (Express API)
- **Frontend** at http://localhost:5173 (Vite React app)

Open http://localhost:5173 in your browser.

## How It Works

1. **Enter a question** in the search box
2. **Backend performs KG-RAG**:
   - Embeds your query
   - Vector search for similar KG nodes
   - Expands graph to find related triplets
   - Generates AI answer from context
3. **Frontend visualizes**:
   - Shows the answer on the left
   - Renders the knowledge graph on the right
   - Highlights vector-matched nodes
   - Displays retrieval statistics

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Graph Visualizer                          │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Frontend (React + Vite)          Backend (Express)          │
│  ┌──────────────────────┐        ┌──────────────────────┐   │
│  │ Query Input          │        │ /api/query           │   │
│  │ Answer Display       │◄──────►│ - Vector search      │   │
│  │ Graph Visualization  │        │ - Graph expansion    │   │
│  │ (react-force-graph)  │        │ - AI generation      │   │
│  └──────────────────────┘        └──────────────────────┘   │
│                                           │                   │
└───────────────────────────────────────────┼───────────────────┘
                                            │
                                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    SAP HANA Cloud                            │
│  Knowledge Graph (pdf_documents) + Vector Engine             │
└─────────────────────────────────────────────────────────────┘
```

## Graph Legend

| Color | Entity Type |
|-------|-------------|
| 🔴 Red | Person |
| 🔵 Blue | Organization |
| 🟢 Green | Product |
| 🟣 Purple | Service |
| 🟠 Orange | Technology |
| 🔵 Cyan | Concept |
| 🟡 Yellow Ring | Vector Match |

## Customization

### Adjust Query Parameters

Edit `server/index.ts`:

```typescript
// Vector search
const [kgNodes, scores] = await graphStore.vectorQuery({
  queryEmbedding: embedding,
  similarityTopK: 5,  // Increase for more matches
});

// Graph expansion
const triplets = await graphStore.getRelMap({
  nodes: kgNodes,
  depth: 2,    // Increase for deeper traversal
  limit: 50,   // Increase for more triplets
});
```

### Change Graph Colors

Edit the `TYPE_COLORS` object in `server/index.ts` to customize entity type colors.

## Troubleshooting

### "Database not connected"

- Ensure `multi-doc-chat/.env.local` exists with valid HANA credentials
- Run `pnpm upload` in `multi-doc-chat` first to create the graph

### "No graph displayed"

- Check that triplets were extracted during upload
- Try a broader query
- Increase `similarityTopK` or `limit` in server

### Graph is too cluttered

- Reduce `limit` in `getRelMap` call
- Reduce `pathDepth` for shallower traversal

### Images not displaying

- Ensure extracted images exist in `multi-doc-chat/extracted_images/`
- Check browser console for 404 errors on image paths
- Verify the image table exists and has entries
