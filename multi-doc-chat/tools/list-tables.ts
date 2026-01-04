import { createHanaConnection, hanaExec } from "hana-kgvector";
import dotenv from "dotenv";

dotenv.config({ path: ".env.local" });

async function main() {
  const conn = await createHanaConnection({
    host: process.env.HANA_HOST!,
    port: parseInt(process.env.HANA_PORT || "443"),
    user: process.env.HANA_USER!,
    password: process.env.HANA_PASSWORD!,
  });

  try {
    const tables: any = await hanaExec(conn, "SELECT TABLE_NAME FROM TABLES WHERE TABLE_NAME LIKE '%VECTORS' OR TABLE_NAME LIKE '%NODES' OR TABLE_NAME LIKE '%IMAGES'");
    console.log("Found tables:", JSON.stringify(tables, null, 2));
  } catch (err: any) {
    console.error("Error listing tables:", err.message);
  } finally {
    conn.disconnect();
  }
}

main().catch(console.error);
