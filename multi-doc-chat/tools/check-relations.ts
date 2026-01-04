/**
 * Check Relations Tool
 * 
 * Inspects the graph to verify structural relations (ON_SAME_PAGE, ADJACENT_TO)
 * are being created by AdjacencyLinker.
 * 
 * Usage: pnpm run check-relations
 */

import { createHanaConnection, hanaExec } from "hana-kgvector";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const GRAPH_NAME = process.env.GRAPH_NAME || "MULTI_DOC_GRAPH";

async function main() {
  console.log(`\n🔍 Checking relations in graph: ${GRAPH_NAME}\n`);

  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    port: parseInt(process.env.HANA_PORT || "443"),
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });

  try {
    // 1. List all tables with the graph name prefix
    console.log("📊 Tables with graph prefix:");
    const tables: any = await hanaExec(conn, `SELECT TABLE_NAME FROM TABLES WHERE TABLE_NAME LIKE '${GRAPH_NAME}%' ORDER BY TABLE_NAME`);
    tables.forEach((t: any) => console.log(`   - ${t.TABLE_NAME}`));

    // 2. Check for CHUNK entities in vectors table
    console.log("\n📈 CHUNK entities in _VECTORS:");
    const chunks: any = await hanaExec(conn, `SELECT COUNT(*) as CNT FROM "${GRAPH_NAME}_VECTORS" WHERE LABEL = 'CHUNK'`);
    console.log(`   Total CHUNK entities: ${chunks[0].CNT}`);

    // 3. Check for structural relation types in properties
    console.log("\n🔗 Checking for structural relations in entity properties...");
    const structuralCheck: any = await hanaExec(conn, `
      SELECT 
        LABEL,
        COUNT(*) as CNT
      FROM "${GRAPH_NAME}_VECTORS"
      WHERE PROPERTIES LIKE '%ON_SAME_PAGE%' OR PROPERTIES LIKE '%ADJACENT_TO%' OR PROPERTIES LIKE '%CONTAINS%'
      GROUP BY LABEL
    `);
    if (structuralCheck.length > 0) {
      console.log("   Found structural relations in properties:");
      structuralCheck.forEach((r: any) => console.log(`     - ${r.LABEL}: ${r.CNT}`));
    } else {
      console.log("   ⚠️  No structural relations found in PROPERTIES column");
    }

    // 4. Check NODES table for image chunks
    console.log("\n🖼️  Image chunks in _NODES:");
    const imageNodes: any = await hanaExec(conn, `
      SELECT ID, LEFT(METADATA, 200) as META_PREVIEW 
      FROM "${GRAPH_NAME}_NODES" 
      WHERE METADATA LIKE '%"contentType":"image"%'
      LIMIT 5
    `);
    if (imageNodes.length > 0) {
      console.log(`   Found ${imageNodes.length} image chunks:`);
      imageNodes.forEach((n: any) => console.log(`     - ${n.ID}`));
    } else {
      console.log("   ⚠️  No image chunks found in _NODES");
    }

    // 5. Cross-reference with _IMAGES table
    console.log("\n🔗 Cross-referencing _NODES with _IMAGES:");
    const crossRef: any = await hanaExec(conn, `
      SELECT i.IMAGE_ID, i.PAGE_NUMBER, i.IMAGE_PATH
      FROM "${GRAPH_NAME}_IMAGES" i
      LIMIT 5
    `);
    if (crossRef.length > 0) {
      console.log(`   Images in _IMAGES table:`);
      crossRef.forEach((img: any) => console.log(`     - ${img.IMAGE_ID} (page ${img.PAGE_NUMBER}): ${img.IMAGE_PATH}`));
    }

    // 6. Summary
    console.log("\n" + "=".repeat(60));
    console.log("📋 SUMMARY");
    console.log("=".repeat(60));
    console.log(`   Tables found: ${tables.length}`);
    console.log(`   CHUNK entities: ${chunks[0].CNT}`);
    console.log(`   Image chunks: ${imageNodes.length}`);
    console.log(`   Images in BLOB table: ${crossRef.length}`);
    
    if (structuralCheck.length === 0) {
      console.log("\n⚠️  ISSUE: Structural relations (ON_SAME_PAGE, ADJACENT_TO) not found.");
      console.log("   This may indicate AdjacencyLinker is not creating relations,");
      console.log("   or they are stored in a different location (RDF graph).");
    }

  } catch (error: any) {
    console.error("\n❌ Error:", error.message);
  } finally {
    conn.disconnect();
  }
}

main().catch(console.error);
