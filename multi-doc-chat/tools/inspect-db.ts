/**
 * Database Inspection Tool for Multi-Doc Chat
 * 
 * This tool allows you to inspect the contents of the three main tables used:
 * 1. _NODES (Llama nodes / Text chunks)
 * 2. _VECTORS (KG entity embeddings)
 * 3. _IMAGES (Image BLOBs and descriptions)
 * 
 * Usage:
 *   tsx tools/inspect-db.ts --table nodes --limit 5
 *   tsx tools/inspect-db.ts --table vectors --limit 5
 *   tsx tools/inspect-db.ts --table images --limit 5
 */

import { createHanaConnection, hanaExec } from "hana-kgvector";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: ".env.local" });

const GRAPH_NAME = process.env.GRAPH_NAME || "MULTI_DOC_GRAPH";
const TABLE_TYPES = {
  nodes: `${GRAPH_NAME}_NODES`,
  vectors: `${GRAPH_NAME}_VECTORS`,
  images: `${GRAPH_NAME}_IMAGES`,
};

async function main() {
  const args = process.argv.slice(2);
  const tableKey = args.includes("--table") ? args[args.indexOf("--table") + 1] : "nodes";
  const limit = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1]) : 10;
  
  if (!TABLE_TYPES[tableKey as keyof typeof TABLE_TYPES]) {
    console.error(`Invalid table type. Use: ${Object.keys(TABLE_TYPES).join(", ")}`);
    process.exit(1);
  }

  const tableName = TABLE_TYPES[tableKey as keyof typeof TABLE_TYPES];

  console.log(`\n🔍 Inspecting table: ${tableName} (limit: ${limit})`);

  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    port: parseInt(process.env.HANA_PORT || "443"),
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });

  try {
    // 1. Get column info
    const columns: any = await hanaExec(conn, `SELECT COLUMN_NAME, DATA_TYPE_NAME FROM TABLE_COLUMNS WHERE TABLE_NAME = '${tableName}'`);
    console.log("\n📊 Columns:");
    columns.forEach((col: any) => console.log(`   - ${col.COLUMN_NAME} (${col.DATA_TYPE_NAME})`));

    // 2. Get row count
    const countResult: any = await hanaExec(conn, `SELECT COUNT(*) as CNT FROM "${tableName}"`);
    console.log(`\n📈 Total rows: ${countResult[0].CNT}`);

    // 3. Get sample data (excluding heavy BLOB/VECTOR columns for display)
    const colList = columns
      .filter((c: any) => !["BLOB", "REAL_VECTOR", "NCLOB"].includes(c.DATA_TYPE_NAME))
      .map((c: any) => `"${c.COLUMN_NAME}"`)
      .join(", ");
    
    // Add truncated version of NCLOBs if they exist
    const clobCols = columns
        .filter((c: any) => c.DATA_TYPE_NAME === "NCLOB")
        .map((c: any) => `LEFT("${c.COLUMN_NAME}", 100) as "${c.COLUMN_NAME}_PREVIEW"`)
        .join(", ");

    const selectSql = `SELECT ${colList}${clobCols ? ", " + clobCols : ""} FROM "${tableName}" LIMIT ${limit}`;
    const data: any = await hanaExec(conn, selectSql);

    console.log(`\n📝 Sample Data (${data.length} rows):`);
    console.table(data);

    if (tableKey === "nodes") {
        console.log("\n💡 Note: TEXT and METADATA (NCLOB) are truncated in the preview.");
    }

  } catch (error: any) {
    console.error("\n❌ Error:", error.message);
  } finally {
    conn.disconnect();
  }
}

main().catch(console.error);
