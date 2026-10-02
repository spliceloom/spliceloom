import { apiGet, fail, toRepository, type RateLimit, type Repository } from "../lib/github.ts";

interface SearchInput {
  query: string;
  sort?: "best-match" | "stars" | "forks" | "updated";
  order?: "desc" | "asc";
  perPage?: number;
  page?: number;
}

interface SearchOutput {
  query: string;
  totalCount: number;
  incompleteResults: boolean;
  page: number;
  perPage: number;
  repositories: Repository[];
  rateLimit: RateLimit;
}

export default async function searchRepositories(input: SearchInput): Promise<SearchOutput> {
  const query = input.query.trim();
  if (query.length === 0) throw fail("INVALID_INPUT", "query must not be empty");
  if (/[\u0000-\u001f]/.test(query)) throw fail("INVALID_INPUT", "query must not contain control characters");
  const perPage = input.perPage ?? 10;
  const page = input.page ?? 1;
  const params: Record<string, string | number> = { q: query, per_page: perPage, page };
  if (input.sort && input.sort !== "best-match") {
    params.sort = input.sort;
    params.order = input.order ?? "desc";
  }
  const { data, rateLimit } = await apiGet("/search/repositories", params);
  const body = (data ?? {}) as { total_count?: unknown; incomplete_results?: unknown; items?: unknown };
  const items = Array.isArray(body.items) ? body.items : [];
  return {
    query,
    totalCount: typeof body.total_count === "number" ? body.total_count : 0,
    incompleteResults: body.incomplete_results === true,
    page,
    perPage,
    repositories: items.map((r) => toRepository(r as Record<string, unknown>)),
    rateLimit,
  };
}
