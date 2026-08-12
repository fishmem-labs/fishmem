const selfHostedPaths = ["", "/privacy", "/terms"];

export async function getSitemapEntries() {
  return selfHostedPaths.map((path) => ({ path }));
}
