# hana-kgvector Examples

This directory contains example applications demonstrating how to use `hana-kgvector` for building GraphRAG applications.

## Available Examples

### 📄 [PDF Chat](./pdf-chat)

A complete PDF document Q&A system with:
- PDF text extraction and chunking
- Knowledge graph extraction (entities + relations)
- Interactive chat interface
- Hybrid vector + graph retrieval

**Perfect for:** Document analysis, research assistants, knowledge base systems

[→ View PDF Chat Example](./pdf-chat)

## Getting Started

Each example is a standalone project with its own dependencies. Navigate to the example directory and follow its README:

```bash
cd pdf-chat
pnpm install
# Follow the README.md instructions
```

## Prerequisites

All examples require:

1. **SAP HANA Cloud** instance with:
   - Knowledge Graph Engine enabled
   - Vector Engine enabled

2. **LLM API** (OpenAI, LiteLLM proxy, or compatible endpoint)

## Example Structure

Each example includes:
- `package.json` - Dependencies and scripts
- `README.md` - Detailed setup and usage instructions
- `.env.example` - Environment variable template
- TypeScript source files

## Contributing Examples

Have an interesting use case? We welcome example contributions! Examples should:
- Be self-contained and runnable
- Include clear documentation
- Demonstrate real-world usage patterns
- Follow TypeScript best practices

## Learn More

- [Main Documentation](../README.md)
- [Tutorial](../TUTORIAL.md)
- [npm Package](https://www.npmjs.com/package/hana-kgvector)
