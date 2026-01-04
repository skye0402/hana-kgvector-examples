/**
 * Check if CHUNK entities exist in _VECTORS table
 */

import { createHanaConnection, hanaExec } from "hana-kgvector";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const GRAPH_NAME = process.env.GRAPH_NAME || "MULTI_DOC_GRAPH";

async function main() {
  console.log(`\n🔍 Checking CHUNK entities in ${GRAPH_NAME}_VECTORS\n`);

  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    port: parseInt(process.env.HANA_PORT || "443"),
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });

  try {
    // 1. Count CHUNK entities
    const chunkCount: any = await hanaExec(conn, `SELECT COUNT(*) as CNT FROM "${GRAPH_NAME}_VECTORS" WHERE LABEL = 'CHUNK'`);
    console.log(`📊 CHUNK entities in _VECTORS: ${chunkCount[0].CNT}`);

    // 2. Sample CHUNK entity IDs
    const chunks: any = await hanaExec(conn, `SELECT ID, NAME FROM "${GRAPH_NAME}_VECTORS" WHERE LABEL = 'CHUNK' LIMIT 10`);
    console.log("\n📝 Sample CHUNK entity IDs:");
    chunks.forEach((c: any) => console.log(`   - ID: ${c.ID}, NAME: ${c.NAME}`));

    // 3. Check what IDs AdjacencyLinker would create
    const nodes: any = await hanaExec(conn, `SELECT ID FROM "${GRAPH_NAME}_NODES" LIMIT 5`);
    console.log("\n📝 Sample _NODES IDs (source for AdjacencyLinker):");
    nodes.forEach((n: any) => {
      const expectedChunkId = `CHUNK_${n.ID.replace(/\s+/g, "_").toUpperCase()}`;
      console.log(`   - Node ID: ${n.ID}`);
      console.log(`     Expected CHUNK entity ID: ${expectedChunkId}`);
    });

    // 4. Check if expected CHUNK IDs exist
    console.log("\n🔗 Checking if expected CHUNK IDs exist in _VECTORS:");
    for (const n of nodes.slice(0, 3)) {
      const expectedId = `CHUNK_${n.ID.replace(/\s+/g, "_").toUpperCase()}`;
      const exists: any = await hanaExec(conn, `SELECT COUNT(*) as CNT FROM "${GRAPH_NAME}_VECTORS" WHERE ID = '${expectedId}'`);
      console.log(`   - ${expectedId}: ${exists[0].CNT > 0 ? '✅ EXISTS' : '❌ MISSING'}`);
    }

  } catch (error: any) {
    console.error("\n❌ Error:", error.message);
  } finally {
    conn.disconnect();
  }
}

main().catch(console.error);
