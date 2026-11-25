// Jar key management + AEAD helpers.
//
// The key normally lives in the OS credential manager (Windows Credential
// Manager via keytar). keytar is a native module and can fail to load (missing
// prebuilt binary, unsupported platform, locked keychain, ...). A failure must
// never take the server down, so we degrade to a machine-bound key derived from
// the hostname and username, and warn exactly once.
import crypto from "node:crypto";
import os from "node:os";
import type { EncryptedBlob } from "../types.js";

const SERVICE = "captcha-handoff";
const ACCOUNT = "jar-key";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const AAD = Buffer.from("captcha-handoff", "utf8");
const FALLBACK_SALT = "captcha-handoff/jar-key/v0.1";

/** Minimal shape we need from keytar (kept local so a missing module is harmless). */
interface KeytarApi {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

let cachedKey: Buffer | undefined;
let pendingKey: Promise<Buffer> | undefined;
let warnedAboutFallback = false;

function warnFallback(err: unknown): void {
  if (warnedAboutFallback) return;
  warnedAboutFallback = true;
  const detail = err instanceof Error ? err.message : String(err);
  console.warn(
    `[captcha-handoff] OS keychain unavailable (${detail}); ` +
      "using a machine-bound fallback key. Jar entries will not be portable to other machines.",
  );
}

/** Create a stable key from this machine's identity (fallback only). */
function deriveMachineKey(): Buffer {
  let username = "";
  try {
    username = os.userInfo().username;
  } catch {
    // userInfo() can throw in odd sandboxes; hostname + salt is still stable.
  }
  let hostname = "";
  try {
    hostname = os.hostname();
  } catch {
    // Ignore: the salt still provides a deterministic seed.
  }
  const seed = `${hostname}\u0000${username}\u0000${FALLBACK_SALT}`;
  return crypto.createHash("sha256").update(seed, "utf8").digest();
}

function decodeKey(encoded: string): Buffer | undefined {
  const key = Buffer.from(encoded, "base64");
  return key.length === KEY_BYTES ? key : undefined;
}

function resolveKeytar(mod: typeof import("keytar")): KeytarApi | undefined {
  // Node's CJS interop normally exposes keytar's methods as named exports, but
  // fall back to the default export in case only that is present.
  const namespace = mod as unknown as Partial<KeytarApi> & {
    default?: Partial<KeytarApi>;
  };
  for (const candidate of [namespace, namespace.default]) {
    if (
      candidate &&
      typeof candidate.getPassword === "function" &&
      typeof candidate.setPassword === "function"
    ) {
      return candidate as KeytarApi;
    }
  }
  return undefined;
}

async function loadKey(): Promise<Buffer> {
  try {
    const keytarModule = await import("keytar");
    const keytar = resolveKeytar(keytarModule);
    if (!keytar) {
      throw new Error("keytar did not expose the expected API");
    }

    const stored = await keytar.getPassword(SERVICE, ACCOUNT);
    if (stored) {
      const decoded = decodeKey(stored);
      if (decoded) return decoded;
      // Stored value is corrupt/truncated; overwrite it below.
    }

    const generated = crypto.randomBytes(KEY_BYTES);
    await keytar.setPassword(SERVICE, ACCOUNT, generated.toString("base64"));
    return generated;
  } catch (err) {
    warnFallback(err);
    return deriveMachineKey();
  }
}

/**
 * Get the jar encryption key, creating and persisting one on first use.
 * Always resolves to a 32-byte key; never rejects because of keychain errors.
 */
export async function getOrCreateKey(): Promise<Buffer> {
  if (cachedKey) return cachedKey;
  if (!pendingKey) {
    pendingKey = loadKey()
      .then((key) => {
        cachedKey = key;
        return key;
      })
      .catch((err) => {
        pendingKey = undefined;
        throw err;
      });
  }
  return pendingKey;
}

/** Encrypt a buffer with AES-256-GCM. Every call uses a fresh random IV. */
export async function encrypt(plain: Buffer): Promise<EncryptedBlob> {
  const key = await getOrCreateKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);

  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: data.toString("base64"),
    alg: "aes-256-gcm",
  };
}

/**
 * Decrypt an AEAD blob. Throws if the algorithm is unknown or the tag does not
 * verify (tampered or wrong key).
 */
export async function decrypt(blob: EncryptedBlob): Promise<Buffer> {
  if (blob.alg !== "aes-256-gcm") {
    throw new Error(`Unsupported jar encryption algorithm: ${String(blob.alg)}`);
  }

  const key = await getOrCreateKey();
  const iv = Buffer.from(blob.iv, "base64");
  const tag = Buffer.from(blob.tag, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(AAD);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(Buffer.from(blob.data, "base64")),
    decipher.final(),
  ]);
}
