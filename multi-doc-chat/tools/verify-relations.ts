import { createHanaConnection, HanaPropertyGraphStore } from "hana-kgvector";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

const GRAPH_NAME = process.env.GRAPH_NAME || "MULTI_DOC_GRAPH";

async function main() {
  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    port: parseInt(process.env.HANA_PORT || "443"),
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });

  try {
    const store = new HanaPropertyGraphStore(conn, { graphName: GRAPH_NAME });

    // Pick a few CHUNK nodes to anchor relation lookup
    const anchors = await store.get({
      ids: [
        "CHUNK_START_OP2025_CHUNK_0",
        "CHUNK_START_OP2025_IMAGE_0",
        "CHUNK_START_OP2025_CHUNK_1",
      ],
    });

    console.log(`Anchors found: ${anchors.length}`);
    for (const a of anchors) console.log(`- ${a.id} (${a.label})`);

    const triplets = await store.getRelMap({
      nodes: anchors,
      depth: 1,
      limit: 200,
      // don't ignore HAS_SOURCE here; we want to see everything present
      ignoreRels: [],
    });

    console.log(`\nTriplets returned by getRelMap(): ${triplets.length}`);
    for (const [s, rel, o] of triplets.slice(0, 30)) {
      console.log(`${s.id} --[${rel.label}]--> ${o.id}`);
    }

    // Also specifically check for structural predicates by label
    const structural = triplets.filter((t) => ["ON_SAME_PAGE", "ADJACENT_TO", "CONTAINS"].includes(t[1].label));
    console.log(`\nStructural triplets among returned: ${structural.length}`);
    for (const [s, rel, o] of structural.slice(0, 30)) {
      console.log(`${s.id} --[${rel.label}]--> ${o.id}`);
    }
  } finally {
    conn.disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
