/**
 * Self-service sign-up by GitHub account. No OAuth application and no secret: the publisher puts a
 * one-time code in the description of a public gist, and the registry reads that account's public
 * gists from the GitHub API. Only public data is read; nothing is written to GitHub.
 */

/** What the registry needs to know about a GitHub account to verify a sign-up. */
export interface GitHubAccount {
  login: string;
  /** "User" for personal accounts. Organizations and bots cannot sign up. */
  type: string;
  createdAt: string;
  /** Descriptions of the account's most recently updated public gists. */
  gistDescriptions: string[];
}

export interface GitHubIdentity {
  /** The account, or null when GitHub has no such user. Throws when GitHub cannot be reached. */
  lookup(login: string): Promise<GitHubAccount | null>;
}

/** GitHub logins: letters, digits and single dashes, at most 39 characters. */
export const GITHUB_LOGIN_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

export const SIGNUP_CODE_PREFIX = "splice-signup-";
export const SIGNUP_CHALLENGE_MINUTES = 30;
/** Accounts younger than this cannot sign up (throwaway accounts made to squat names). */
export const SIGNUP_MIN_ACCOUNT_AGE_DAYS = 30;
export const SIGNUP_TOKEN_DAYS = 365;

export function newSignupCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return SIGNUP_CODE_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface GitHubIdentityConfig {
  fetch?: typeof fetch;
  /** Optional token: only raises GitHub's rate limit for these public reads. */
  token?: string;
  apiUrl?: string;
}

/** Reads the public profile and public gists of an account from the GitHub REST API. */
export function githubIdentity(config: GitHubIdentityConfig = {}): GitHubIdentity {
  const doFetch = config.fetch ?? fetch;
  const api = (config.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const headers: Record<string, string> = { accept: "application/vnd.github+json", "user-agent": "splice-registry", "x-github-api-version": "2022-11-28" };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  return {
    async lookup(login) {
      if (!GITHUB_LOGIN_PATTERN.test(login)) return null;
      const profile = await doFetch(`${api}/users/${login}`, { headers });
      if (profile.status === 404) return null;
      if (!profile.ok) throw new Error(`GitHub returned ${profile.status}`);
      const user = (await profile.json()) as { login?: unknown; type?: unknown; created_at?: unknown };
      const gists = await doFetch(`${api}/users/${login}/gists?per_page=30`, { headers });
      if (!gists.ok) throw new Error(`GitHub returned ${gists.status}`);
      const list = (await gists.json()) as Array<{ description?: unknown; public?: unknown; owner?: { login?: unknown } }>;
      return {
        login: String(user.login ?? ""),
        type: String(user.type ?? ""),
        createdAt: String(user.created_at ?? ""),
        gistDescriptions: (Array.isArray(list) ? list : [])
          .filter((g) => g.public === true && typeof g.owner?.login === "string" && g.owner.login.toLowerCase() === login.toLowerCase() && typeof g.description === "string")
          .map((g) => g.description as string),
      };
    },
  };
}
