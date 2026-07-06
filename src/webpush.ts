// Standards Web Push sender: RFC 8291 (aes128gcm message encryption) and
// RFC 8292 (VAPID) on node:crypto alone, so the hub can deliver to browser
// push services without a dependency. Payloads here are small JSON pager
// frames (a question or permission headline), far under one record, so the
// single-record encoding is all we need.
//
// The scheme, end to end: the browser's PushSubscription carries a P-256
// public key (p256dh) and a 16-byte auth secret. We make an ephemeral P-256
// pair per message, ECDH against p256dh, then two HKDF stages derive an
// AES-128-GCM key and nonce that only that browser can re-derive. The push
// service in the middle (FCM, Mozilla, Apple) sees ciphertext only. VAPID
// signs a short-lived ES256 JWT proving to the push service which server is
// allowed to wake this subscription.

import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign as cryptoSign,
  type JsonWebKey,
  type KeyObject,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./paths.js";

export const VAPID_FILE = join(STATE_DIR, "webpush-vapid.json");

export interface PushSubscriptionJSON {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

interface VapidStore {
  // Uncompressed P-256 point (65 bytes) base64url: what the page hands to
  // pushManager.subscribe as applicationServerKey.
  publicKey: string;
  privateJwk: JsonWebKey;
}

const b64url = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

let cachedVapid: { store: VapidStore; privateKey: KeyObject } | null = null;

/** Load the machine's VAPID keypair, minting one on first use (0600). The key
 * identifies this machine to push services; regenerating it orphans existing
 * subscriptions, so it is created once and kept. */
export function loadVapid(): { publicKey: string; privateKey: KeyObject } {
  if (cachedVapid) {
    return { publicKey: cachedVapid.store.publicKey, privateKey: cachedVapid.privateKey };
  }
  let store: VapidStore | null = null;
  try {
    const parsed = JSON.parse(readFileSync(VAPID_FILE, "utf8")) as VapidStore;
    if (parsed.publicKey && parsed.privateJwk) store = parsed;
  } catch {
    // mint below
  }
  if (!store) {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pubJwk = pair.publicKey.export({ format: "jwk" });
    const point = Buffer.concat([
      Buffer.from([0x04]),
      fromB64url(pubJwk.x as string),
      fromB64url(pubJwk.y as string),
    ]);
    store = {
      publicKey: b64url(point),
      privateJwk: pair.privateKey.export({ format: "jwk" }) as JsonWebKey,
    };
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(VAPID_FILE, JSON.stringify(store), { mode: 0o600 });
  }
  const privateKey = createPrivateKey({ key: store.privateJwk, format: "jwk" });
  cachedVapid = { store, privateKey };
  return { publicKey: store.publicKey, privateKey };
}

/** RFC 8292 Authorization header for one push-service origin: a 12-hour ES256
 * JWT plus the public key the service verifies it against. */
function vapidAuthHeader(audience: string): string {
  const { publicKey, privateKey } = loadVapid();
  const enc = (obj: unknown): string => b64url(Buffer.from(JSON.stringify(obj)));
  const contact = process.env["MURMUR_PUSH_CONTACT"] ?? "mailto:murmur-mcp@users.noreply.github.com";
  const input = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: contact,
  })}`;
  // Push services expect the raw r||s signature form, not ASN.1 DER.
  const sig = cryptoSign("sha256", Buffer.from(input), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${input}.${b64url(sig)}, k=${publicKey}`;
}

/** RFC 8291 single-record aes128gcm encryption of `plaintext` for one
 * subscription. Returns the wire body: header block plus ciphertext. */
export function encryptForSubscription(
  sub: PushSubscriptionJSON,
  plaintext: Buffer
): Buffer {
  const uaPublic = fromB64url(sub.keys.p256dh); // 65-byte uncompressed point
  const authSecret = fromB64url(sub.keys.auth); // 16-byte shared auth secret

  const ephemeral = createECDH("prime256v1");
  ephemeral.generateKeys();
  const asPublic = ephemeral.getPublicKey(); // uncompressed, 65 bytes
  const ecdhSecret = ephemeral.computeSecret(uaPublic);

  // HKDF stage 1: mix the ECDH secret with the subscription's auth secret,
  // bound to both public keys, yielding the input keying material.
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));

  // HKDF stage 2: derive the content key and nonce under a fresh salt.
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));

  // One record: payload, then 0x02 marking it as the final record.
  const record = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  // aes128gcm header: salt(16) | record size(4, BE) | keyid len(1) | keyid.
  const recordSize = Math.max(4096, ciphertext.length + 16);
  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ciphertext]);
}

export interface PushSendResult {
  ok: boolean;
  status: number;
  // 404/410 from the push service: the subscription is dead and must be
  // dropped (user cleared site data, revoked permission, or reinstalled).
  gone: boolean;
}

/** Encrypt and deliver one payload to one subscription's push service. Never
 * throws: network and service failures come back as { ok: false }. */
export async function sendWebPush(
  sub: PushSubscriptionJSON,
  payload: unknown,
  opts?: { ttlSeconds?: number; urgency?: "very-low" | "low" | "normal" | "high" }
): Promise<PushSendResult> {
  try {
    const body = encryptForSubscription(sub, Buffer.from(JSON.stringify(payload)));
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        authorization: vapidAuthHeader(new URL(sub.endpoint).origin),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(opts?.ttlSeconds ?? 600),
        urgency: opts?.urgency ?? "high",
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch {
    return { ok: false, status: 0, gone: false };
  }
}
