import { z } from "zod";

export const noteSchema = z.object({
  id: z.string(),
  folder: z.string().catch("/"),
  title: z.string(),
  tags: z.array(z.string()).catch([]),
  sensitivity: z.string().catch("personal"),
  agent_enabled: z.boolean().catch(true),
  pinned: z.boolean().catch(false),
  version: z.number().catch(1),
  updated_at: z.string().catch(""),
});

export const noteListSchema = z.object({
  items: z.array(noteSchema),
  folders: z.array(z.string()).catch([]),
  tags: z.array(z.string()).catch([]),
});

export const noteDetailSchema = noteSchema.extend({
  content: z.string().catch(""),
  backlinks: z.array(z.unknown()).catch([]),
});

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
