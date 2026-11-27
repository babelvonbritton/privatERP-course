export const ATTACHMENT_ENTITY_TYPES = ["invoice", "member", "session", "profile"] as const;
export type AttachmentEntityType = (typeof ATTACHMENT_ENTITY_TYPES)[number];

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
