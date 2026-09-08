import { z } from "zod";

const documentIdentity = z.object({ id: z.string(), version: z.number().int().positive() });
const documentFormDetail = documentIdentity.extend({ title: z.string(), content_md: z.string() });

export function validateDocumentFormResult(targetId: string, input: unknown): z.infer<typeof documentIdentity> {
  const result = documentIdentity.parse(input);
  if (result.id !== targetId) throw new Error("DETAIL_ID_MISMATCH");
  return result;
}

export function parseDocumentFormDetail(targetId: string, input: unknown): z.infer<typeof documentFormDetail> {
  validateDocumentFormResult(targetId, input);
  return documentFormDetail.parse(input);
}

export type FormVersionField = "version" | "expected_version";

export function buildFormRequestBody(
  fieldNames: readonly string[],
  values: Readonly<Record<string, string>>,
  versionField: FormVersionField | undefined,
  initialValues: Readonly<Record<string, string>> | undefined,
): Record<string, string | number> {
  const body: Record<string, string | number> = Object.fromEntries(
    fieldNames.map((name) => [name, values[name] ?? ""]),
  );
  if (!versionField) return body;
  const token = initialValues?.version;
  const version = token && /^\d+$/.test(token) ? Number(token) : Number.NaN;
  if (!Number.isSafeInteger(version) || version <= 0) throw new Error("MISSING_VERSION");
  body[versionField] = version;
  return body;
}
