export { CoreError, type CoreErrorCode } from "./errors.js";
export { CONFIG_FILE, LEGACY_LOCK_FILE, LOCK_FILE, STATE_DIR, SpliceProject, type LockEntry, type Lockfile, type ProjectConfig } from "./project.js";
export { ArtifactCache } from "./cache.js";
export {
  DEFAULT_REGISTRY_URL,
  LOCAL_REGISTRY_URL,
  PRODUCTION_REGISTRY_URL,
  REGISTRY_ALIASES,
  expandRegistry,
  getToken,
  readUserConfig,
  removeCredential,
  resolveRegistry,
  saveCredential,
  spliceHome,
  writeUserConfig,
  type RegistrySource,
  type UserConfig,
} from "./user-config.js";
export { RegistryClient, type FetchLike } from "./registry-client.js";
export { generateSigningKey, keysDir, listSigningKeys, loadSigningKey, signPackage, signPublishedVersion, type SigningKey } from "./signing-keys.js";
export {
  addPackage,
  installProject,
  listPackages,
  outdatedPackages,
  removePackage,
  resolveInstalledTool,
  updatePackages,
  type AddOptions,
  type AddResult,
  type InstallStep,
  type InstalledPackage,
  type OutdatedPackage,
  type UpdateOptions,
  type UpdateResult,
} from "./installer.js";
export { installedFilesDigest, packDirectory, type PackResult } from "./pack.js";
export { assertInstalledIntact } from "./installer.js";
export { publishPackage, type PublishOptions, type PublishResult, type PublishStep } from "./publish.js";
export { verifyPackage, type VerificationReport, type VerifyOptions } from "./verify.js";
