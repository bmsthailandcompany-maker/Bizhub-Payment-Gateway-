import crypto from "node:crypto";

/** Minimal S3-compatible client (AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO) for off-site backups. */
export interface S3Config {
  endpoint: string; // e.g. https://s3.ap-southeast-1.amazonaws.com or https://<account>.r2.cloudflarestorage.com
  bucket: string;
  region: string; // "auto" for R2
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

const sha256hex = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding of each path segment, as SigV4 requires. */
function encodePath(p: string): string {
  return p
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()))
    .join("/");
}

/** AWS Signature Version 4 for a request whose headers are all signed. Returns the Authorization header. */
export function signV4(input: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  amzDate: string; // YYYYMMDDTHHMMSSZ
}): string {
  const date = input.amzDate.slice(0, 8);
  const lower = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v.trim()]));
  const names = Object.keys(lower).sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const query = [...input.url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  const canonicalRequest = [input.method, encodePath(decodeURIComponent(input.url.pathname)), query, canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + input.secretAccessKey, date), input.region), input.service), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

/** Uploads one object (path-style URL, which every S3-compatible service accepts). */
export async function putObject(cfg: S3Config, key: string, body: Buffer, contentType: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const url = new URL(`${cfg.endpoint.replace(/\/+$/, "")}/${cfg.bucket}/${(cfg.prefix ? cfg.prefix.replace(/\/+$/, "") + "/" : "") + key}`);
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const payloadHash = sha256hex(body);
  const headers: Record<string, string> = {
    host: url.host,
    "content-type": contentType,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  const authorization = signV4({ method: "PUT", url, headers, payloadHash, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: cfg.region, service: "s3", amzDate });
  const res = await fetchImpl(url, { method: "PUT", headers: { ...headers, authorization }, body: new Uint8Array(body), signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`S3 upload of ${key} failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}
