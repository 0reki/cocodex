import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

let cachedInitSchemaSql: string | undefined

export function getInitSchemaSql() {
  if (cachedInitSchemaSql) return cachedInitSchemaSql

  const schemaPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../sql/init.sql",
  )
  cachedInitSchemaSql = readFileSync(schemaPath, "utf8")
  return cachedInitSchemaSql
}
