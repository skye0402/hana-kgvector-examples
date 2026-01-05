# hana-kgvector Examples

This repository contains example applications demonstrating how to use [`hana-kgvector`](https://www.npmjs.com/package/hana-kgvector) for building GraphRAG applications with SAP HANA Cloud.

## Available Examples

### 📚 [Multi-Document Chat](./multi-doc-chat)

A full-featured multi-document Q&A system with **image processing**:
- Upload multiple PDFs into a unified knowledge graph
- **Image extraction & VLM descriptions** - images become searchable text
- Cross-document queries with source attribution
- Document filtering and comparison commands
- Structural adjacency linking for better multimodal retrieval

**Perfect for:** Technical documentation, research papers, multi-source analysis

[→ View Multi-Doc Chat Example](./multi-doc-chat)

---

### 🕸️ [Graph Visualizer](./graph-visualizer)

Interactive web UI to **visualize** your knowledge graph and query results:
- Real-time graph visualization with force-directed layout
- AI-powered answers with **inline image rendering**
- Vector match highlighting and retrieval statistics
- Resizable panels and Markdown-formatted responses

**Perfect for:** Understanding retrieval behavior, demos, debugging

[→ View Graph Visualizer Example](./graph-visualizer)

---

### 📄 [PDF Chat](./pdf-chat)

A simpler single-document Q&A system (no image processing):
- PDF text extraction and chunking
- Knowledge graph extraction (entities + relations)
- Interactive chat interface
- Hybrid vector + graph retrieval

**Perfect for:** Getting started, simple document analysis

[→ View PDF Chat Example](./pdf-chat)

---

## Quick Start

Each example is a standalone project. Pick one and follow its README:

```bash
# Recommended: Start with multi-doc-chat for the full experience
cd multi-doc-chat
pnpm install
cp .env.example .env.local  # Configure credentials
# Edit .env.local with your HANA + LLM credentials
pnpm upload your-document.pdf
pnpm chat

# Then visualize with the graph visualizer
cd ../graph-visualizer
pnpm install
pnpm dev
# Open http://localhost:5173
```

## Prerequisites

All examples require:

1. **SAP HANA Cloud** instance with:
   - Knowledge Graph Engine enabled
   - Vector Engine enabled

2. **LLM API** (OpenAI, LiteLLM proxy, or compatible endpoint)

3. **Node.js 18+** and **pnpm** (recommended) or npm

## Example Comparison

| Feature | PDF Chat | Multi-Doc Chat | Graph Visualizer |
|---------|----------|----------------|------------------|
| Multiple documents | ❌ | ✅ | N/A (uses multi-doc-chat data) |
| Image processing | ❌ | ✅ | ✅ (displays images) |
| Web UI | ❌ (CLI) | ❌ (CLI) | ✅ |
| Graph visualization | ❌ | ❌ | ✅ |
| Document filtering | ❌ | ✅ | ❌ |
| Structural linking | ❌ | ✅ | ✅ |

## Project Structure

```
hana-kgvector-examples/
├── multi-doc-chat/       # Multi-document + image processing example
│   ├── upload-docs.ts    # PDF upload with image extraction
│   ├── chat.ts           # Interactive chat CLI
│   ├── list-docs.ts      # List uploaded documents
│   └── tools/            # Diagnostic utilities
├── graph-visualizer/     # Web-based graph visualization
│   ├── server/           # Express backend
│   └── src/              # React frontend
├── pdf-chat/             # Simple single-document example
│   ├── upload-pdf.ts     # PDF upload
│   └── chat.ts           # Interactive chat CLI
└── docs/                 # Additional documentation
```

## Contributing Examples

Have an interesting use case? We welcome example contributions! Examples should:
- Be self-contained and runnable
- Include clear documentation
- Demonstrate real-world usage patterns
- Follow TypeScript best practices

## Learn More

- [npm Package](https://www.npmjs.com/package/hana-kgvector)
- [Knowledge Graph Introduction](./docs/kg-introduction.md)
