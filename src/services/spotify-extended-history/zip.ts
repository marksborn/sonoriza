import { readFile } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const MAX_EOCD_SEARCH = 0xffff + 22;
const MAX_ENTRY_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;

export type InMemoryZipEntry = {
  name: string;
  data: Buffer;
};

type CentralDirectoryEntry = {
  name: string;
  flags: number;
  compressionMethod: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

export async function readZipEntries(filePath: string): Promise<InMemoryZipEntry[]> {
  const archive = await readFile(filePath);
  return readZipEntriesFromBuffer(archive);
}

export function readZipEntriesFromBuffer(archive: Buffer): InMemoryZipEntry[] {
  const eocdOffset = findEndOfCentralDirectory(archive);
  const totalEntries = archive.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = archive.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(eocdOffset + 16);

  if (
    totalEntries === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new Error("ZIP64 archives are not supported by HISTORY-02");
  }

  if (centralDirectoryOffset + centralDirectorySize > archive.length) {
    throw new Error("Invalid ZIP central directory bounds");
  }

  const entries: CentralDirectoryEntry[] = [];
  let cursor = centralDirectoryOffset;
  let totalUncompressedBytes = 0;

  for (let index = 0; index < totalEntries; index += 1) {
    ensureRange(archive, cursor, 46, "central directory header");
    if (archive.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Invalid ZIP central directory signature at entry ${index}`);
    }

    const flags = archive.readUInt16LE(cursor + 8);
    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const fileNameLength = archive.readUInt16LE(cursor + 28);
    const extraFieldLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    const headerSize = 46 + fileNameLength + extraFieldLength + commentLength;

    ensureRange(archive, cursor, headerSize, "central directory entry");
    const name = archive
      .subarray(cursor + 46, cursor + 46 + fileNameLength)
      .toString("utf8");

    if ((flags & 0x1) !== 0) {
      throw new Error(`Encrypted ZIP entry is not supported: ${name}`);
    }
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error(`Unsupported ZIP compression method ${compressionMethod} for ${name}`);
    }
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error(`ZIP entry is too large: ${name}`);
    }

    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error("ZIP uncompressed size exceeds HISTORY-02 safety limit");
    }

    entries.push({
      name,
      flags,
      compressionMethod,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor += headerSize;
  }

  return entries
    .filter((entry) => !entry.name.endsWith("/"))
    .map((entry) => ({ name: entry.name, data: readEntryData(archive, entry) }));
}

function readEntryData(archive: Buffer, entry: CentralDirectoryEntry): Buffer {
  const offset = entry.localHeaderOffset;
  ensureRange(archive, offset, 30, `local header for ${entry.name}`);

  if (archive.readUInt32LE(offset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error(`Invalid ZIP local header for ${entry.name}`);
  }

  const localFileNameLength = archive.readUInt16LE(offset + 26);
  const localExtraFieldLength = archive.readUInt16LE(offset + 28);
  const dataOffset = offset + 30 + localFileNameLength + localExtraFieldLength;
  ensureRange(archive, dataOffset, entry.compressedSize, `compressed data for ${entry.name}`);

  const compressed = archive.subarray(dataOffset, dataOffset + entry.compressedSize);
  const data = entry.compressionMethod === 0 ? compressed : inflateRawSync(compressed);

  if (data.length !== entry.uncompressedSize) {
    throw new Error(`ZIP size mismatch for ${entry.name}: expected ${entry.uncompressedSize}, got ${data.length}`);
  }

  return Buffer.from(data);
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const minimumOffset = Math.max(0, archive.length - MAX_EOCD_SEARCH);
  for (let offset = archive.length - 22; offset >= minimumOffset; offset -= 1) {
    if (archive.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new Error("ZIP end-of-central-directory record not found");
}

function ensureRange(buffer: Buffer, offset: number, length: number, label: string): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error(`Invalid ZIP bounds while reading ${label}`);
  }
}
