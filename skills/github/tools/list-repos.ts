import { apiGet, checkOwner, toRepository, type RateLimit, type Repository } from "../lib/github.ts";

interface ListReposInput {
  owner: string;
  type?: "all" | "owner" | "member";
  sort?: "created" | "updated" | "pushed" | "full_name";
  perPage?: number;
  page?: number;
}

interface ListReposOutput {
  owner: string;
  page: number;
  perPage: number;
  repositories: Repository[];
  hasMore: boolean;
  rateLimit: RateLimit;
}

export default async function listRepos(input: ListReposInput): Promise<ListReposOutput> {
  const owner = checkOwner(input.owner);
  const perPage = input.perPage ?? 20;
  const page = input.page ?? 1;
  const { data, rateLimit } = await apiGet(`/users/${owner}/repos`, { type: input.type ?? "owner", sort: input.sort ?? "updated", per_page: perPage, page });
  const list = Array.isArray(data) ? data : [];
  return { owner, page, perPage, repositories: list.map((r) => toRepository(r as Record<string, unknown>)), hasMore: list.length === perPage, rateLimit };
}
