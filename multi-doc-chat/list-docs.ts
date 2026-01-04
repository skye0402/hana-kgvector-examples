/**
 * List Documents in the Knowledge Graph
 * 
 * Utility script to see what documents have been uploaded.
 * 
 * Usage: pnpm list
 */

import {
  createHanaConnection,
  HanaPropertyGraphStore,
} from "hana-kgvector";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const GRAPH_NAME = "multi_doc_graph";

async function main() {
  console.log("=".repeat(70));
  console.log("  List Uploaded Documents");
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
  
  // Query for unique document IDs
  console.log(`\n📚 Documents in graph '${GRAPH_NAME}':\n`);
  
  try {
    // Query the nodes table for unique documentId values
    const nodesTable = `"${GRAPH_NAME}_NODES"`;
    const result = await conn.exec(`
      SELECT DISTINCT 
        JSON_VALUE(PROPERTIES, '$.documentId') as DOC_ID,
        COUNT(*) as CHUNK_COUNT
      FROM ${nodesTable}
      WHERE JSON_VALUE(PROPERTIES, '$.documentId') IS NOT NULL
      GROUP BY JSON_VALUE(PROPERTIES, '$.documentId')
      ORDER BY DOC_ID
    `);
    
    if (result.length === 0) {
      console.log("   No documents found. Run 'pnpm upload' first.\n");
    } else {
      console.log(`   Found ${result.length} document(s):\n`);
      for (const row of result) {
        console.log(`   • ${row.DOC_ID}`);
        console.log(`     Chunks: ${row.CHUNK_COUNT}`);
      }
      console.log();
    }
  } catch (error: any) {
    if (error.message?.includes("invalid table name")) {
      console.log("   No documents found. Run 'pnpm upload' first.\n");
    } else {
      throw error;
    }
  }
  
  process.exit(0);
}

main().catch((error) => {
  console.error("\n❌ Error:", error.message);
  process.exit(1);
});
