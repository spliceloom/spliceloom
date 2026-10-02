/**
 * Splice package archive: a deterministic `.tar.gz` (ustar) built and read with Web platform APIs
 * only, so it works in Node.js, Cloudflare Workers and browsers without dependencies.
 *
 * Determinism: files are sorted by path; every header uses mode 0644, uid/gid 0, mtime 0 and empty
 * user/group names; no directory entries. The gzip layer uses *stored* deflate blocks (no
 * compression) with a fixed header (mtime 0, OS 255), so identical package contents give identical
 * bytes — and therefore the same SHA-256 — on every machine and runtime. Any gzip/tar tool can read
 * the result. Packages are limited to 5 MB, so the missing compression is acceptable.
 *
 * Reading is strict: only regular files; symlinks, hard links, devices and PAX/GNU extension
 * headers are rejected; paths go through the same safety checks as the JSON bundle format.
 */
import { SpecError } from "./errors.js";
import { MAX_BUNDLE_BYTES, MAX_BUNDLE_FILES, decodeBundle, isSafeBundlePath, type BundleFile } from "./bundle.js";

export const ARCHIVE_EXTENSION = ".tar.gz";
export const ARCHIVE_CONTENT_TYPE = "application/gzip";
/** Upper bound on the decompressed tar stream (protects against decompression bombs). */
export const MAX_UNPACKED_BYTES = 16 * 1024 * 1024;

export type ArchiveFormat = "tar.gz" | "json-bundle";

const BLOCK = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

// ------------------------------------------------------------------ crc32

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------------ tar

function writeString(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new SpecError("INVALID_BUNDLE", `Tar field too long: "${value}"`);
  header.set(bytes, offset);
}

function writeOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  writeString(header, offset, length, value.toString(8).padStart(length - 1, "0") + "\0");
}

/** Splits a path into ustar prefix/name (name ≤ 100 bytes, prefix ≤ 155 bytes). */
function splitPath(path: string): { prefix: string; name: string } {
  if (encoder.encode(path).length <= 100) return { prefix: "", name: path };
  const parts = path.split("/");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) return { prefix, name };
  }
  throw new SpecError("INVALID_BUNDLE", `Path too long for a tar archive: "${path}"`);
}

function tarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const { prefix, name } = splitPath(path);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156); // checksum placeholder: spaces
  header[156] = 0x30; // '0' regular file
  writeString(header, 257, 6, "ustar\0");
  writeString(header, 263, 2, "00");
  writeString(header, 345, 155, prefix);
  let sum = 0;
  for (const b of header) sum += b;
  writeString(header, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return header;
}

function buildTar(files: readonly BundleFile[]): Uint8Array {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let total = BLOCK * 2;
  for (const f of sorted) total += BLOCK + Math.ceil(f.content.length / BLOCK) * BLOCK;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const f of sorted) {
    out.set(tarHeader(f.path, f.content.length), offset);
    offset += BLOCK;
    out.set(f.content, offset);
    offset += Math.ceil(f.content.length / BLOCK) * BLOCK;
  }
  return out; // trailing two zero blocks are already zero-filled
}

// ------------------------------------------------------------------ gzip (stored blocks)

function gzipStored(data: Uint8Array): Uint8Array {
  const maxBlock = 0xffff;
  const blocks = Math.max(1, Math.ceil(data.length / maxBlock));
  const out = new Uint8Array(10 + data.length + blocks * 5 + 8);
  // ID1 ID2 CM FLG MTIME(4) XFL OS
  out.set([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff], 0);
  let o = 10;
  for (let i = 0; i < blocks; i++) {
    const start = i * maxBlock;
    const len = Math.min(maxBlock, data.length - start);
    out[o++] = i === blocks - 1 ? 0x01 : 0x00; // BFINAL + BTYPE=00 (stored)
    out[o++] = len & 0xff;
    out[o++] = len >>> 8;
    out[o++] = ~len & 0xff;
    out[o++] = (~len >>> 8) & 0xff;
    out.set(data.subarray(start, start + len), o);
    o += len;
  }
  const crc = crc32(data);
  const size = data.length >>> 0;
  out.set([crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, crc >>> 24, size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, size >>> 24], o);
  return out;
}

/** Deterministic `.tar.gz` of the package files. */
export function encodeTarGz(files: readonly BundleFile[]): Uint8Array {
  const seen = new Set<string>();
  for (const f of files) {
    if (!isSafeBundlePath(f.path)) throw new SpecError("INVALID_BUNDLE", `Unsafe file path in archive: "${f.path}"`);
    const key = f.path.toLowerCase();
    if (seen.has(key)) throw new SpecError("INVALID_BUNDLE", `Duplicate file path in archive: "${f.path}"`);
    seen.add(key);
  }
  if (files.length > MAX_BUNDLE_FILES) throw new SpecError("INVALID_BUNDLE", `Package has ${files.length} files (max ${MAX_BUNDLE_FILES})`);
  const archive = gzipStored(buildTar(files));
  if (archive.byteLength > MAX_BUNDLE_BYTES) {
    throw new SpecError("INVALID_BUNDLE", `Archive is ${archive.byteLength} bytes (max ${MAX_BUNDLE_BYTES})`);
  }
  return archive;
}

// ------------------------------------------------------------------ reading

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UNPACKED_BYTES) {
        await reader.cancel();
        throw new SpecError("INVALID_BUNDLE", `Archive expands beyond ${MAX_UNPACKED_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SpecError) throw error;
    throw new SpecError("INVALID_BUNDLE", "Archive is not valid gzip");
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function readString(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  try {
    return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
  } catch {
    throw new SpecError("INVALID_BUNDLE", "Tar header contains invalid UTF-8");
  }
}

function readOctal(block: Uint8Array, offset: number, length: number): number {
  const text = readString(block, offset, length).trim();
  if (!/^[0-7]*$/.test(text)) throw new SpecError("INVALID_BUNDLE", "Tar header contains an invalid number");
  return text === "" ? 0 : parseInt(text, 8);
}

function parseTar(tar: Uint8Array): BundleFile[] {
  const files: BundleFile[] = [];
  const seen = new Set<string>();
  let offset = 0;
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i]!;
    if (readOctal(header, 148, 8) !== sum) throw new SpecError("INVALID_BUNDLE", "Tar header checksum mismatch");
    const magic = readString(header, 257, 6);
    if (!magic.startsWith("ustar")) throw new SpecError("INVALID_BUNDLE", "Not a ustar archive");

    const type = String.fromCharCode(header[156]!);
    const size = readOctal(header, 124, 12);
    const prefix = readString(header, 345, 155);
    const rawName = readString(header, 0, 100);
    const path = (prefix ? `${prefix}/${rawName}` : rawName).replace(/^\.\//, "");
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new SpecError("INVALID_BUNDLE", `Truncated archive entry "${path}"`);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "5") continue; // directory entries carry no content
    if (type !== "0" && type !== "\0") {
      throw new SpecError("INVALID_BUNDLE", `Unsupported archive entry "${path}" (type '${type}'): only regular files are allowed`);
    }
    if (!isSafeBundlePath(path)) throw new SpecError("INVALID_BUNDLE", `Unsafe file path in archive: "${path}"`);
    const key = path.toLowerCase();
    if (seen.has(key)) throw new SpecError("INVALID_BUNDLE", `Duplicate file path in archive: "${path}"`);
    seen.add(key);
    files.push({ path, content: tar.slice(dataStart, dataEnd) });
    if (files.length > MAX_BUNDLE_FILES) throw new SpecError("INVALID_BUNDLE", `Archive has more than ${MAX_BUNDLE_FILES} files`);
  }
  return files;
}

export function archiveFormat(bytes: Uint8Array): ArchiveFormat {
  return bytes[0] === 0x1f && bytes[1] === 0x8b ? "tar.gz" : "json-bundle";
}

/** Reads a package artifact: `.tar.gz` (current) or the JSON bundle (Phase 1/2 artifacts). */
export async function decodePackageArchive(bytes: Uint8Array): Promise<BundleFile[]> {
  if (bytes.byteLength > MAX_BUNDLE_BYTES) {
    throw new SpecError("INVALID_BUNDLE", `Archive is ${bytes.byteLength} bytes (max ${MAX_BUNDLE_BYTES})`);
  }
  return archiveFormat(bytes) === "tar.gz" ? parseTar(await gunzip(bytes)) : decodeBundle(bytes);
}
