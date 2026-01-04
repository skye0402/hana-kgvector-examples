/**
 * Check RDF Relations Tool
 * 
 * Queries the HANA Graph RDF store to verify structural relations
 * (ON_SAME_PAGE, ADJACENT_TO) are being created by AdjacencyLinker.
 * 
 * Usage: pnpm run check-rdf
 */

import { createHanaConnection, hanaExec } from "hana-kgvector";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const GRAPH_NAME = process.env.GRAPH_NAME || "MULTI_DOC_GRAPH";

function asSparqlTable(sql: string) {
  const escaped = sql.replace(/'/g, "''");
  return `SELECT * FROM SPARQL_TABLE('${escaped}')`;
}

async function main() {
  console.log(`\n🔍 Checking RDF relations in graph: ${GRAPH_NAME}\n`);

  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    port: parseInt(process.env.HANA_PORT || "443"),
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });

  try {
    // 1) Total triples
    console.log("📊 Total triples in named graph...");
    const totalRows = (await hanaExec(
      conn,
      asSparqlTable(`
        SELECT (COUNT(*) AS ?cnt)
        FROM <${GRAPH_NAME}>
        WHERE { ?s ?p ?o . }
      `)
    )) as any[];
    console.log(`   Total triples: ${totalRows?.[0]?.CNT ?? totalRows?.[0]?.cnt ?? "(unknown)"}`);

    // 2) Structural counts
    console.log("\n🔗 Structural relation counts...");
    const adjacentRows = (await hanaExec(
      conn,
      asSparqlTable(`
        SELECT (COUNT(*) AS ?cnt)
        FROM <${GRAPH_NAME}>
        WHERE { ?s <urn:hkv:rel:ADJACENT_TO> ?o . }
      `)
    )) as any[];
    const samePageRows = (await hanaExec(
      conn,
      asSparqlTable(`
        SELECT (COUNT(*) AS ?cnt)
        FROM <${GRAPH_NAME}>
        WHERE { ?s <urn:hkv:rel:ON_SAME_PAGE> ?o . }
      `)
    )) as any[];
    console.log(`   ADJACENT_TO: ${adjacentRows?.[0]?.CNT ?? adjacentRows?.[0]?.cnt ?? "(unknown)"}`);
    console.log(`   ON_SAME_PAGE: ${samePageRows?.[0]?.CNT ?? samePageRows?.[0]?.cnt ?? "(unknown)"}`);

    // 3) Predicate histogram (top 30)
    console.log("\n📈 Top predicates in graph...");
    const predRows = (await hanaExec(
      conn,
      asSparqlTable(`
        SELECT ?p (COUNT(*) AS ?cnt)
        FROM <${GRAPH_NAME}>
        WHERE { ?s ?p ?o . }
        GROUP BY ?p
        ORDER BY DESC(?cnt)
        LIMIT 30
      `)
    )) as any[];
    for (const r of predRows ?? []) {
      console.log(`   ${r.P ?? r.p}: ${r.CNT ?? r.cnt}`);
    }

    // 4) Sample structural relations
    console.log("\n� Sample structural relations...");
    const sampleRows = (await hanaExec(
      conn,
      asSparqlTable(`
        SELECT ?s ?p ?o
        FROM <${GRAPH_NAME}>
        WHERE {
          ?s ?p ?o .
          FILTER(?p IN (<urn:hkv:rel:ADJACENT_TO>, <urn:hkv:rel:ON_SAME_PAGE>))
        }
        LIMIT 20
      `)
    )) as any[];
    for (const r of sampleRows ?? []) {
      console.log(`   ${r.S ?? r.s} --[${r.P ?? r.p}]--> ${r.O ?? r.o}`);
    }

  } catch (error: any) {
    console.error("\n❌ Error:", error.message);
  } finally {
    conn.disconnect();
  }
}

main().catch(console.error);
