export class CatalogReadCancellation extends Error {
  constructor(readonly reason: "replaced" | "view_closed" | "shutdown") {
    super(reason);
  }
}
