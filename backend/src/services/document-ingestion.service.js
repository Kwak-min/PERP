import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { newId } from "../models/base.js";
import { ApiError, invalid } from "../utils/errors.js";

export const MAX_DOCUMENT_UPLOAD_BYTES = 1_000_000;
const DEFAULT_UPLOAD_ROOT = fileURLToPath(new URL("../uploads/", import.meta.url));
const FORMATS = new Map([
  [".md", { format: "markdown", mimes: new Set(["text/markdown", "text/plain"]) }],
  [".txt", { format: "plain_text", mimes: new Set(["text/plain"]) }],
]);

function decodeBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw invalid("content_base64 must be canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) throw invalid("uploaded document is empty");
  if (bytes.length > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new ApiError("PAYLOAD_TOO_LARGE", `uploaded document exceeds ${MAX_DOCUMENT_UPLOAD_BYTES} bytes`, {}, 413);
  }
  return bytes;
}

export function extractSupportedTextUpload({ filename, mime, content_base64: encoded }) {
  if (filename !== path.basename(filename) || /[\u0000-\u001f\u007f]/.test(filename)) {
    throw invalid("filename must not contain a path or control characters");
  }
  const extension = path.extname(filename).toLowerCase();
  const spec = FORMATS.get(extension);
  if (!spec || !spec.mimes.has(mime.toLowerCase())) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "only UTF-8 .md and .txt document uploads are supported", {
      supported: [".md (text/markdown or text/plain)", ".txt (text/plain)"],
    }, 415);
  }
  if (!path.basename(filename, extension).trim()) throw invalid("uploaded document filename must include a title");
  const bytes = decodeBase64(encoded);
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid("uploaded document must contain valid UTF-8 text");
  }
  if (text.includes("\u0000")) throw invalid("uploaded document must not contain NUL bytes");
  return { bytes, text, extension, format: spec.format, mime: mime.toLowerCase() };
}

export function uploadRoot() {
  return path.resolve(process.env.ORBITFLOW_UPLOAD_DIR?.trim() || DEFAULT_UPLOAD_ROOT);
}

export async function persistUploadedSource({ tenantId, orgId, extension, bytes }) {
  const id = newId();
  const storageKey = path.join(tenantId, orgId, `${id}${extension}`);
  const root = uploadRoot();
  const destination = path.resolve(root, storageKey);
  if (!destination.startsWith(`${root}${path.sep}`)) throw invalid("invalid upload storage scope");
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx" });
  return {
    id,
    storageKey,
    checksum: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    async discard() { await rm(destination, { force: true }); },
  };
}
