import { PublicAppError } from "../../lib/app-error";
import { one } from "../../lib/db";
import {
  FORTNOX_INBOX_PATHS,
  FortnoxApiError,
  retrieveInboxFile,
  uploadInboxFile,
  verifyInboxFolder
} from "./client";

export async function pushReceiptToFortnoxInbox(env: Env, receiptId: string) {
  const receipt = await one<any>(env.DB, "SELECT * FROM receipts WHERE id=?", receiptId);
  if (!receipt) throw new PublicAppError(404, "Receipt not found.");

  const inboxPath = receipt.fortnox_inbox_path || FORTNOX_INBOX_PATHS.SUPPLIER_DOCUMENT;
  const existingFileId = receipt.fortnox_file_id || receipt.fortnox_inbox_file_id;
  if (existingFileId) {
    try {
      await retrieveInboxFile(env, existingFileId);
    } catch (error) {
      if (error instanceof FortnoxApiError && error.status === 404) {
        throw new PublicAppError(409, "Mapped Fortnox Inbox file not found");
      }
      throw error;
    }
    return {
      receipt_id: receipt.id,
      fortnox_file_id: existingFileId,
      fortnox_inbox_path: inboxPath,
      reused: true
    };
  }

  const { folderId } = await verifyInboxFolder(env, inboxPath);

  const object = await env.RECEIPTS.get(receipt.r2_key);
  if (!object?.body) throw new PublicAppError(404, "File missing");

  const blob = await new Response(object.body).blob();
  const file = new File([blob], receipt.filename, { type: receipt.mime_type });
  const result = await uploadInboxFile(env, file, inboxPath, { folderId });
  const fileId = result.File?.Id ?? null;
  const archiveFileId = result.File?.ArchiveFileId ?? null;
  if (!fileId) throw new PublicAppError(502, "Fortnox Inbox upload returned no file id.");

  await env.DB.prepare(
    `UPDATE receipts
     SET fortnox_file_id=?,
         fortnox_inbox_file_id=?,
         fortnox_archive_file_id=?,
         fortnox_inbox_path=?,
         pushed_to_fortnox_at=CURRENT_TIMESTAMP,
         status='INBOX_UPLOADED',
         updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).bind(fileId, fileId, archiveFileId, inboxPath, receipt.id).run();

  return {
    receipt_id: receipt.id,
    fortnox_file_id: fileId,
    fortnox_archive_file_id: archiveFileId,
    fortnox_inbox_path: inboxPath,
    reused: false,
    fortnox: result
  };
}
