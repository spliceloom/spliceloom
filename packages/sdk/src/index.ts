export { Skill, Splice, type PackageInfo, type SpliceOptions } from "./splice.js";
export type { PackageManager, PackageResolver, SkillLoader, SkillRuntime } from "./interfaces.js";
export { ProjectPackageManager, ProjectSkillLoader, RegistryPackageResolver } from "./defaults.js";
// Types an SDK user commonly needs, re-exported so `@spliceloom/sdk` is the only import.
export {
  ArtifactCache,
  CoreError,
  RegistryClient,
  type AddOptions,
  type AddResult,
  type InstalledPackage,
  type OutdatedPackage,
  type UpdateOptions,
  type UpdateResult,
  type PublishResult,
  type VerificationReport,
} from "@spliceloom/core";
export {
  PackageContentVerifier,
  MetadataVerifier,
  SignaturePolicyVerifier,
  Sha256Verifier,
  SizeVerifier,
  defaultVerifiers,
  verifyArtifact,
  type PackageSignature,
  type PackageVerifier,
  type VerificationCheck,
  type VerificationResult,
} from "@spliceloom/spec";
export { RuntimeError, SpliceRuntime, type LoadedPackage, type ToolResult } from "@spliceloom/runtime";
export {
  CHAINS,
  SpliceData,
  isLive,
  type AiGenerateInput,
  type AiMessage,
  type AiResult,
  type AiTool,
  type CallOptions,
  type Composite,
  type DataResult,
  type MarketPair,
  type Provenance,
  type ProviderStatus,
  type SpliceDataOptions,
  type WebCallOptions,
} from "@spliceloom/data";
export { SpecError, describeTools, type JsonSchema, type Manifest, type SearchResult, type ToolDescriptor } from "@spliceloom/spec";
