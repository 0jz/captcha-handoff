import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { encrypt, decrypt } from "../src/jar/keychain.js";
import { createJarStore } from "../src/jar/store.js";
import { loadConfig } from "../src/config.js";
import type { Config, EncryptedBlob, JarEntry } from "../src/types.js";

function blob(data = "hello"): EncryptedBlob {
  return {
    iv: Buffer.from("0123456789ab").toString("base64"),
    tag: Buffer.from("0123456789abcdef").toString("base64"),
    data: Buffer.from(data).toString("base64"),
    alg: "aes-256-gcm",
  };
}

function entry(site: string, savedAt: number, expiresHint: number): JarEntry {
  return {
    site,
    savedAt,
    expiresHint,
    cookies: blob("cookies"),
    localStorage: blob("{}"),
    origin: "test",
  };
}

describe("jar", () => {
  let dir: string;
  let cfg: Config;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "captcha-handoff-test-"));
    cfg = { ...loadConfig({}), jarDir: dir };
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips encryption", async () => {
    const plain = Buffer.from("sensitive session data", "utf8");
    const encrypted = await encrypt(plain);
    expect(encrypted.alg).toBe("aes-256-gcm");
    const decrypted = await decrypt(encrypted);
    expect(decrypted.toString("utf8")).toBe("sensitive session data");
  });

  it("rejects tampered ciphertext", async () => {
    const encrypted = await encrypt(Buffer.from("data"));
    const tampered = { ...encrypted, data: encrypted.data.slice(0, -4) + "AAAA" };
    await expect(decrypt(tampered)).rejects.toThrow();
  });

  it("saves, gets and lists entries", async () => {
    const store = createJarStore(cfg);
    await store.save(entry("example.com", 1000, 2000));
    await store.save(entry("other.org", 2000, 3000));

    const got = await store.get("example.com");
    expect(got).toBeDefined();
    expect(got!.site).toBe("example.com");

    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list[0].site).toBe("other.org"); // newest first
  });

  it("returns undefined for a missing site", async () => {
    const store = createJarStore(cfg);
    expect(await store.get("nope.com")).toBeUndefined();
  });

  it("purges expired entries only", async () => {
    const store = createJarStore(cfg);
    await store.save(entry("live.com", 1000, Date.now() + 60_000));
    await store.save(entry("dead.com", 1000, Date.now() - 1));
    await store.purge();
    const list = await store.list();
    expect(list.map((e) => e.site)).toEqual(["live.com"]);
  });
});
