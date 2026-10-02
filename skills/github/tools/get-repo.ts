import { apiGet, checkOwner, checkRepo, toRepository, type RateLimit, type Repository } from "../lib/github.ts";

interface GetRepoInput {
  owner: string;
  repo: string;
}

interface GetRepoOutput {
  repository: Repository;
  rateLimit: RateLimit;
}

export default async function getRepo(input: GetRepoInput): Promise<GetRepoOutput> {
  const owner = checkOwner(input.owner);
  const repo = checkRepo(input.repo);
  const { data, rateLimit } = await apiGet(`/repos/${owner}/${repo}`);
  return { repository: toRepository(data as Record<string, unknown>), rateLimit };
}
