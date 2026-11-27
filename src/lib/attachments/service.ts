import { AppError } from "@/lib/errors/AppError";
import type { BackupAsset } from "@/lib/backup/types";
import { MAX_ATTACHMENT_BYTES, type Attachment, type AttachmentEntityType } from "@/lib/domain/attachments";
import type { OlaseenaDatabase } from "@/lib/storage/OlaseenaDatabase";
import { createId } from "@/lib/storage/utils";
import { extensionForMime, type PreparedAttachment } from "./compress";

type AuditFn = (action: string, entity: string, entityId: string, detail: string) => Promise<void>;

interface AddAttachmentInput {
  entityType: AttachmentEntityType;
  entityId: string;
  prepared: PreparedAttachment;
}

/** Finds the asset bytes for one attachment id inside a verified backup. */
function assetForId(assets: Map<string, Uint8Array>, id: string): Uint8Array | undefined {
  for (const [name, bytes] of assets) {
    if (name === `assets/images/${id}` || name.startsWith(`assets/images/${id}.`)) return bytes;
  }
  return undefined;
}

export class AttachmentService {
  constructor(
    private readonly db: OlaseenaDatabase,
    private readonly audit: AuditFn,
  ) {}

  /** Attachments of one record, oldest first. */
  list(entityType: AttachmentEntityType, entityId: string): Promise<Attachment[]> {
    return this.db.attachments.where("[entityType+entityId]").equals([entityType, entityId]).sortBy("createdAt");
  }

  get(id: string): Promise<Attachment | undefined> {
    return this.db.attachments.get(id);
  }

  /** File bytes for one attachment, or undefined when the file is missing (for example after a restore without its asset). */
  async getBlob(id: string): Promise<Blob | undefined> {
    const [row, meta] = await Promise.all([this.db.attachmentBlobs.get(id), this.db.attachments.get(id)]);
    if (!row) return undefined;
    return new Blob([row.bytes as BlobPart], { type: meta?.mimeType ?? "" });
  }

  async hasBlob(id: string): Promise<boolean> {
    return (await this.db.attachmentBlobs.get(id)) !== undefined;
  }

  /** Stores a prepared image with its metadata and an audit entry, in one transaction. */
  async add(input: AddAttachmentInput): Promise<Attachment> {
    const { prepared } = input;
    if (prepared.sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new AppError("VALIDATION", { details: `${prepared.fileName} is larger than 4 MB` });
    }
    const now = Date.now();
    const attachment: Attachment = {
      id: createId(),
      entityType: input.entityType,
      entityId: input.entityId,
      fileName: prepared.fileName,
      mimeType: prepared.mimeType,
      sizeBytes: prepared.sizeBytes,
      width: prepared.width,
      height: prepared.height,
      createdAt: now,
    };
    const bytes = new Uint8Array(await prepared.blob.arrayBuffer());
    await this.db.transaction("rw", [this.db.attachments, this.db.attachmentBlobs, this.db.auditLog], async () => {
      await this.db.attachments.add(attachment);
      await this.db.attachmentBlobs.add({ id: attachment.id, bytes });
      await this.audit("attachment.add", input.entityType, input.entityId, attachment.fileName);
    });
    return attachment;
  }

  /** Removes one attachment, its bytes, and records the removal in the audit log. */
  async remove(id: string): Promise<void> {
    const attachment = await this.db.attachments.get(id);
    if (!attachment) throw new AppError("NOT_FOUND", { details: `attachment ${id}` });
    await this.db.transaction("rw", [this.db.attachments, this.db.attachmentBlobs, this.db.auditLog], async () => {
      await this.db.attachments.delete(id);
      await this.db.attachmentBlobs.delete(id);
      await this.audit("attachment.remove", attachment.entityType, attachment.entityId, attachment.fileName);
    });
  }

  /** Every stored file as a backup asset, named assets/images/<id>.<ext>. Rows without bytes are skipped: the metadata row is still backed up and the restore warns about the missing file. */
  async listBlobs(): Promise<BackupAsset[]> {
    const rows = await this.db.attachments.toArray();
    const assets: BackupAsset[] = [];
    for (const row of rows) {
      const stored = await this.db.attachmentBlobs.get(row.id);
      if (!stored) continue;
      assets.push({ name: `assets/images/${row.id}.${extensionForMime(row.mimeType)}`, bytes: new Uint8Array(stored.bytes) });
    }
    return assets;
  }

  /** Writes the asset bytes of a verified backup into the blob store, matched by attachment id. Returns how many files were written; metadata rows without a file keep no bytes and show as missing. */
  async writeBlobs(assets: Map<string, Uint8Array>, attachments: Attachment[]): Promise<number> {
    const rows = attachments.filter((a) => assetForId(assets, a.id) !== undefined);
    if (rows.length === 0) return 0;
    await this.db.transaction("rw", this.db.attachmentBlobs, async () => {
      for (const row of rows) {
        const bytes = assetForId(assets, row.id)!;
        await this.db.attachmentBlobs.put({ id: row.id, bytes: new Uint8Array(bytes) });
      }
    });
    return rows.length;
  }
}
