import { manifestId, type Manifest, type PublishResponse } from "@spliceloom/spec";
import { CoreError } from "./errors.js";
import { packDirectory } from "./pack.js";
import type { RegistryClient } from "./registry-client.js";

export type PublishStep = "validating" | "packaging" | "publishing";

export interface PublishOptions {
  /** Validate and pack only; do not contact the registry. */
  dryRun?: boolean;
  onStep?: (step: PublishStep, detail: string) => void;
}

export interface PublishResult {
  id: string;
  version: string;
  manifest: Manifest;
  integrity: string;
  size: number;
  files: number;
  dryRun: boolean;
  response?: PublishResponse;
}

/** Packs a skill directory (validating it against the spec) and publishes it with `token`. */
export async function publishPackage(
  client: RegistryClient,
  dir: string,
  token: string | null,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const step = options.onStep ?? (() => {});
  step("validating", dir);
  const packed = await packDirectory(dir);
  const id = manifestId(packed.manifest);
  step("packaging", `${id}@${packed.manifest.version}`);

  const result: PublishResult = {
    id,
    version: packed.manifest.version,
    manifest: packed.manifest,
    integrity: packed.integrity,
    size: packed.bytes.byteLength,
    files: packed.files.length,
    dryRun: options.dryRun === true,
  };
  if (options.dryRun) return result;

  if (!token) {
    throw new CoreError("NOT_LOGGED_IN", `Not logged in to ${client.baseUrl}.`, {
      hint: "Run `splice login` (or set SPLICE_TOKEN).",
    });
  }
  step("publishing", client.baseUrl);
  const response = await client.publish(packed.bytes, token);
  if (response.integrity !== packed.integrity) {
    throw new CoreError("INTEGRITY_MISMATCH", "The registry stored different bytes than were uploaded", {
      details: [`uploaded ${packed.integrity}`, `registry ${response.integrity}`],
    });
  }
  result.response = response;
  return result;
}
