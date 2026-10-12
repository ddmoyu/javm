// GitHub's REST lookup by tag only returns published releases. The CLI's
// GraphQL lookup also resolves drafts, then the numeric REST lookup provides
// the same asset shape used for published releases.
export function findRelease(gh, repository, tag) {
  try {
    const { databaseId } = JSON.parse(
      gh(["release", "view", tag, "--repo", repository, "--json", "databaseId"]),
    );
    return JSON.parse(gh(["api", "repos/" + repository + "/releases/" + databaseId]));
  } catch (error) {
    if (/release not found|HTTP 404/i.test(String(error.stderr))) return null;
    throw error;
  }
}
