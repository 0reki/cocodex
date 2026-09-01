import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

let cachedInitSchemaSql: string | undefined

export function getInitSchemaSql() {
  if (cachedInitSchemaSql) return cachedInitSchemaSql

  const cwdSchemaPath = path.resolve(process.cwd(), "sql/init.sql")
  const sourceSchemaPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../sql/init.sql",
  )
  const schemaPath = existsSync(cwdSchemaPath) ? cwdSchemaPath : sourceSchemaPath
  cachedInitSchemaSql = readFileSync(schemaPath, "utf8")
  return cachedInitSchemaSql
}
