/** Metadata for one file attached to an invoice, a member, a session, or the business profile logo. The file bytes travel as a real file in the backup ZIP, never inside JSON. */

/** What an attachment can belong to. "profile" is the single business logo, stored under the entity id "profile". */
export const ATTACHMENT_ENTITY_TYPES = ["invoice", "member", "session", "profile"] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

/** Largest file kept for one attachment, in bytes. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

export interface Attachment {
  id: string;
  entityType: AttachmentEntityType;
  entityId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  createdAt: number;
}
