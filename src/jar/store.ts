// File-backed session jar: one JSON entry per registrable domain.
//
// Entries are already AEAD-encrypted (see keychain.ts); this module only deals
// with persistence, lookup, listing and expiry purging.
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config.js";
import type { EncryptedBlob, JarEntry } from "../types.js";

export interface JarStore {
  save(entry: JarEntry): Promise<void>;
  get(site: string): Promise<JarEntry | undefined>;
  list(): Promise<JarEntry[]>;
  /** Delete entries whose expiresHint is in the past. */
  purge(): Promise<void>;
}

const ENTRY_EXT = ".json";

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isEncryptedBlob(value: unknown): value is EncryptedBlob {
  if (typeof value !== "object" || value === null) return false;
  const blob = value as Partial<EncryptedBlob>;
  return (
    typeof blob.iv === "string" &&
    typeof blob.tag === "string" &&
    typeof blob.data === "string" &&
    blob.alg === "aes-256-gcm"
  );
}

function isJarEntry(value: unknown): value is JarEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<JarEntry>;
  return (
    typeof entry.site === "string" &&
    typeof entry.savedAt === "number" &&
    typeof entry.expiresHint === "number" &&
    typeof entry.origin === "string" &&
    isEncryptedBlob(entry.cookies) &&
    isEncryptedBlob(entry.localStorage)
  );
}

/** Map a site to a safe file name (registrable domains are already tame). */
function fileNameForSite(site: string): string {
  const safe = site.trim().toLowerCase().replace(/[^a-z0-9.-]/g, "_");
  return `${safe.length > 0 ? safe : "_"}${ENTRY_EXT}`;
}

async function readEntryFile(file: string): Promise<JarEntry | undefined> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    return isJarEntry(parsed) ? parsed : undefined;
  } catch {
    // Corrupt entry: treat as absent rather than crashing the server.
    return undefined;
  }
}

class FileJarStore implements JarStore {
  constructor(private readonly dir: string) {}

  private entryPath(site: string): string {
    return path.join(this.dir, fileNameForSite(site));
  }

  private async entryFiles(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    return names
      .filter((name) => name.toLowerCase().endsWith(ENTRY_EXT))
      .map((name) => path.join(this.dir, name));
  }

  async save(entry: JarEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      this.entryPath(entry.site),
      JSON.stringify(entry, null, 2),
      "utf8",
    );
  }

  async get(site: string): Promise<JarEntry | undefined> {
    return readEntryFile(this.entryPath(site));
  }

  async list(): Promise<JarEntry[]> {
    const files = await this.entryFiles();
    const entries = await Promise.all(files.map((file) => readEntryFile(file)));
    return entries
      .filter((entry): entry is JarEntry => entry !== undefined)
      .sort((a, b) => b.savedAt - a.savedAt || a.site.localeCompare(b.site));
  }

  async purge(): Promise<void> {
    const now = Date.now();
    const files = await this.entryFiles();

    await Promise.all(
      files.map(async (file) => {
        const entry = await readEntryFile(file);
        if (!entry || entry.expiresHint >= now) return;
        try {
          await unlink(file);
        } catch (err) {
          if (!isEnoent(err)) throw err;
        }
      }),
    );
  }
}

export function createJarStore(cfg: Config): JarStore {
  return new FileJarStore(cfg.jarDir);
}
