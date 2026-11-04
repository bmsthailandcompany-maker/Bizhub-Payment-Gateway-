import assert from "node:assert/strict";
import { test } from "node:test";
import { putObject, signV4 } from "../src/services/s3.ts";

test("SigV4 matches the AWS S3 documentation example (GET Object)", () => {
  const auth = signV4({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    headers: {
      Host: "examplebucket.s3.amazonaws.com",
      Range: "bytes=0-9",
      "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "x-amz-date": "20130524T000000Z",
    },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
    service: "s3",
    amzDate: "20130524T000000Z",
  });
  assert.equal(
    auth,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("putObject sends a signed path-style PUT and surfaces errors", async () => {
  const seen: { url?: string; headers?: Record<string, string>; bytes?: number } = {};
  const ok = (async (url: URL, init: RequestInit) => {
    seen.url = String(url);
    seen.headers = init.headers as Record<string, string>;
    seen.bytes = (init.body as Uint8Array).length;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  const cfg = { endpoint: "https://acc.r2.cloudflarestorage.com/", bucket: "backups", region: "auto", accessKeyId: "AK", secretAccessKey: "SK", prefix: "bizhub/" };
  await putObject(cfg, "db/gateway-1.db", Buffer.from("hello"), "application/octet-stream", ok);
  assert.equal(seen.url, "https://acc.r2.cloudflarestorage.com/backups/bizhub/db/gateway-1.db");
  assert.match(seen.headers!.authorization!, /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.equal(seen.bytes, 5);
  const denied = (async () => new Response("AccessDenied", { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(putObject(cfg, "x", Buffer.from("x"), "text/plain", denied), /HTTP 403 AccessDenied/);
});
