import { z } from "zod";

import { versionTokenSchema } from "./graph3d.ts";

export const analysisSchema = z.object({
  state: z.enum(["pending", "ready", "unavailable", "error", "not_analyzed"]),
  reason: z.string().optional(),
  version: versionTokenSchema,
  model: z.string().nullable(),
  local_only: z.boolean(),
  candidates: z.number().int().optional(),
  candidate_limit: z.number().int().optional(),
  truncated: z.boolean().optional(),
});
export type NoteAnalysis = z.infer<typeof analysisSchema>;

export const noteSchema = z.object({
  id: z.string(),
  folder: z.string().catch("/"),
  title: z.string(),
  tags: z.array(z.string()).catch([]),
  sensitivity: z.string().catch("personal"),
  agent_enabled: z.boolean().catch(true),
  pinned: z.boolean().catch(false),
  version: versionTokenSchema,
  updated_at: z.string().catch(""),
  analysis: analysisSchema.optional(),
});

export function parseNoteResult(targetId: string, input: unknown): Note {
  const note = noteSchema.parse(input);
  if (note.id !== targetId) throw new Error("DETAIL_ID_MISMATCH");
  return note;
}

export const noteListSchema = z.object({
  items: z.array(noteSchema),
  folders: z.array(z.string()).catch([]),
  tags: z.array(z.string()).catch([]),
});

export const noteDetailSchema = noteSchema.extend({
  content: z.string(),
  backlinks: z.array(z.unknown()).catch([]),
});

export function parseNoteDetail(targetId: string, input: unknown): NoteDetail {
  const detail = noteDetailSchema.parse(input);
  if (detail.id !== targetId) throw new Error("DETAIL_ID_MISMATCH");
  return detail;
}

export type Note = z.infer<typeof noteSchema>;
export type NoteDetail = z.infer<typeof noteDetailSchema>;

export type NoteDraft = Readonly<{
  title: string;
  content: string;
  folder: string;
  tags: string;
  pinned: boolean;
  agent_enabled: boolean;
}>;

export const EMPTY_DRAFT: NoteDraft = {
  title: "",
  content: "",
  folder: "/",
  tags: "",
  pinned: false,
  agent_enabled: true,
};

export function draftOf(note: NoteDetail): NoteDraft {
  return {
    title: note.title,
    content: note.content,
    folder: note.folder,
    tags: note.tags.join(", "),
    pinned: note.pinned,
    agent_enabled: note.agent_enabled,
  };
}

export function tagsOf(draft: NoteDraft): readonly string[] {
  return draft.tags
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}
