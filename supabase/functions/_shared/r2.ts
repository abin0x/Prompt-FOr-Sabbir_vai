import { AwsClient } from "npm:aws4fetch@1";

/** Files never change: every upload gets a new name, so caches can keep them. */
export const CACHE_CONTROL = "public, max-age=31536000, immutable";

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing secret ${name}`);
  return value;
}

function objectUrl(key: string): URL {
  // R2_ENDPOINT is only set when testing against a local S3 server.
  const endpoint = Deno.env.get("R2_ENDPOINT") ??
    `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  return new URL(
    `${endpoint.replace(/\/$/, "")}/${requireEnv("R2_BUCKET")}/${encodedKey}`,
  );
}

function client(): AwsClient {
  return new AwsClient({
    accessKeyId: requireEnv("R2_ACCESS_KEY_ID"),
    secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY"),
    service: "s3",
    region: "auto",
  });
}

/** A URL that lets the browser PUT one file directly, valid for a few minutes. */
export async function presignUpload(
  key: string,
  contentType: string,
  expiresSeconds = 900,
): Promise<string> {
  const url = objectUrl(key);
  url.searchParams.set("X-Amz-Expires", String(expiresSeconds));
  const signed = await client().sign(
    new Request(url, {
      method: "PUT",
      headers: { "Content-Type": contentType, "Cache-Control": CACHE_CONTROL },
    }),
    // allHeaders signs Content-Type too, so the file type cannot be swapped.
    { aws: { signQuery: true, allHeaders: true } },
  );
  return signed.url;
}

export async function deleteObject(key: string): Promise<boolean> {
  const response = await client().fetch(objectUrl(key), { method: "DELETE" });
  await response.body?.cancel();
  return response.ok;
}
