import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

/**
 * Vercel serverless 各 instance は短命なので、connection を温存せず即解放する。
 *   - max: 1            … 1 instance あたり最大 1 接続 (Supabase pooler 枠を食い潰さない)
 *   - idle_timeout: 20  … 20 秒アイドルで切断
 *   - connect_timeout: 10 … 取得タイムアウト 10 秒
 *
 * Supabase pooler は session mode (5432) だと枠が小さい (default 15)。
 * 本番 DATABASE_URL は transaction mode pooler (port 6543) を使う方が望ましい。
 */
const client = postgres(connectionString, {
  prepare: false,
  max: 1,
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(client, { schema });
export type Db = typeof db;
