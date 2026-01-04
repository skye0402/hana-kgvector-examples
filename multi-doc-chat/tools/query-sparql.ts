/**
 * Query SPARQL Tool
 * 
 * Uses the library's SPARQL execution to query the RDF graph directly.
 * 
 * Usage: pnpm run query-sparql
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
  console.log(`\n🔍 Querying RDF graph: ${GRAPH_NAME}\n`);

  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    port: parseInt(process.env.HANA_PORT || "443"),
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });

  try {
    // 1. Count all triples
    console.log("📊 Total triples in named graph...");
    const countSql = asSparqlTable(`
      SELECT (COUNT(*) AS ?cnt)
      FROM <${GRAPH_NAME}>
      WHERE { ?s ?p ?o . }
    `);
    const total = (await hanaExec(conn, countSql)) as any[];
    console.log(`   Total triples: ${total?.[0]?.CNT ?? total?.[0]?.cnt ?? "(unknown)"}`);

    // 2. Structural relation counts
    console.log("\nStructural relation counts...");
    const adjacentCountSql = asSparqlTable(`
      SELECT (COUNT(*) AS ?cnt)
      FROM <${GRAPH_NAME}>
      WHERE { ?s <urn:hkv:rel:ADJACENT_TO> ?o . }
    `);
    const samePageCountSql = asSparqlTable(`
      SELECT (COUNT(*) AS ?cnt)
      FROM <${GRAPH_NAME}>
      WHERE { ?s <urn:hkv:rel:ON_SAME_PAGE> ?o . }
    `);
    const [adjCnt, spCnt] = await Promise.all([
      hanaExec(conn, adjacentCountSql),
      hanaExec(conn, samePageCountSql),
    ]);
    const adjCntRows = adjCnt as any[];
    const spCntRows = spCnt as any[];
    console.log(`   ADJACENT_TO: ${adjCntRows?.[0]?.CNT ?? adjCntRows?.[0]?.cnt ?? "(unknown)"}`);
    console.log(`   ON_SAME_PAGE: ${spCntRows?.[0]?.CNT ?? spCntRows?.[0]?.cnt ?? "(unknown)"}`);

    // 3. Sample structural relations
    console.log("\nSample structural relations...");
    const sampleStructSql = asSparqlTable(`
      SELECT ?s ?p ?o
      FROM <${GRAPH_NAME}>
      WHERE {
        ?s ?p ?o .
        FILTER(?p IN (<urn:hkv:rel:ADJACENT_TO>, <urn:hkv:rel:ON_SAME_PAGE>))
      }
      LIMIT 20
    `);
    const structRows = (await hanaExec(conn, sampleStructSql)) as any[];
    for (const r of structRows ?? []) {
      console.log(`   ${r.S ?? r.s} --[${r.P ?? r.p}]--> ${r.O ?? r.o}`);
    }

    // 4. List top predicates (relation types)
    console.log("\nTop predicates in graph...");
    const predSql = asSparqlTable(`
      SELECT ?p (COUNT(*) AS ?cnt)
      FROM <${GRAPH_NAME}>
      WHERE { ?s ?p ?o . }
      GROUP BY ?p
      ORDER BY DESC(?cnt)
      LIMIT 30
    `);
    const preds = (await hanaExec(conn, predSql)) as any[];
    for (const p of preds ?? []) {
      console.log(`   ${p.P ?? p.p}: ${p.CNT ?? p.cnt}`);
    }

    // 5. Image linkage analysis (structural)
    console.log("\nImage linkage analysis (structural edges)...");
    const imgAdjSql = asSparqlTable(`
      SELECT (COUNT(*) AS ?cnt)
      FROM <${GRAPH_NAME}>
      WHERE {
        ?s <urn:hkv:rel:ADJACENT_TO> ?o .
        { ?s <urn:hkv:prop:contentType> "image" } UNION { ?o <urn:hkv:prop:contentType> "image" }
      }
    `);
    const imgAdjRows = (await hanaExec(conn, imgAdjSql)) as any[];
    console.log(`   ADJACENT_TO involving image: ${imgAdjRows?.[0]?.CNT ?? imgAdjRows?.[0]?.cnt ?? "(unknown)"}`);

    const crossTypeAdjSql = asSparqlTable(`
      SELECT (COUNT(*) AS ?cnt)
      FROM <${GRAPH_NAME}>
      WHERE {
        ?s <urn:hkv:rel:ADJACENT_TO> ?o .
        ?s <urn:hkv:prop:contentType> ?sType .
        ?o <urn:hkv:prop:contentType> ?oType .
        FILTER(?sType != ?oType)
      }
    `);
    const crossTypeAdjRows = (await hanaExec(conn, crossTypeAdjSql)) as any[];
    console.log(`   ADJACENT_TO cross-type (e.g., text<->image): ${crossTypeAdjRows?.[0]?.CNT ?? crossTypeAdjRows?.[0]?.cnt ?? "(unknown)"}`);

    const imgSamePageSql = asSparqlTable(`
      SELECT (COUNT(*) AS ?cnt)
      FROM <${GRAPH_NAME}>
      WHERE {
        ?s <urn:hkv:rel:ON_SAME_PAGE> ?o .
        { ?s <urn:hkv:prop:contentType> "image" } UNION { ?o <urn:hkv:prop:contentType> "image" }
      }
    `);
    const imgSamePageRows = (await hanaExec(conn, imgSamePageSql)) as any[];
    console.log(`   ON_SAME_PAGE involving image: ${imgSamePageRows?.[0]?.CNT ?? imgSamePageRows?.[0]?.cnt ?? "(unknown)"}`);
  
  } catch (error: any) {
    console.error("\n❌ Error:", error.message);
  } finally {
    conn.disconnect();
  }
}

main().catch(console.error);
