import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
export function createLibraryFixture(filename: string) {
  const source = readFileSync(
    new URL("../../native/media/src/library_schema.inc", import.meta.url),
    "utf8",
  );
  const database = new DatabaseSync(filename);
  database.exec(source.slice(source.indexOf('R"SQL(') + 6, source.lastIndexOf(')SQL"')));
  return database;
}
