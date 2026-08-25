import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { encryptString } from "../src/lib/crypto";
import { PublicAppError } from "../src/lib/app-error";
import { FORTNOX_INBOX_PATHS, uploadInboxFile } from "../src/integrations/fortnox/client";
import { pushReceiptToFortnoxInbox } from "../src/integrations/fortnox/receipts";
import { resetTables, testKey, workerEnv } from "./helpers";

describe("Fortnox receipt Inbox push", () => {
  const realFetch = globalThis.fetch;
  const r2Key = "receipts/test/receipt.pdf";

  beforeEach(async () => {
    await resetTables();
    await env.DB.prepare(
      `INSERT INTO fortnox_connections
        (id, tenant_id, access_token_enc, refresh_token_enc, token_expires_at, scope)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(
      "fnx_test",
      "tenant-1",
      await encryptString("access-token", testKey()),
      null,
      new Date(Date.now() + 600_000).toISOString(),
      "inbox"
    ).run();
    await env.RECEIPTS.put(r2Key, new Blob(["test receipt"], { type: "application/pdf" }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = realFetch;
  });

  async function insertReceipt(overrides: Record<string, unknown> = {}) {
    await env.DB.prepare(
      `INSERT INTO receipts
        (id, filename, mime_type, r2_key, fortnox_file_id, fortnox_inbox_file_id, fortnox_inbox_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      "rcp_test",
      "receipt.pdf",
      "application/pdf",
      r2Key,
      overrides.fortnox_file_id ?? null,
      overrides.fortnox_inbox_file_id ?? null,
      overrides.fortnox_inbox_path ?? null
    ).run();
  }

  it("uses Inbox_s and verifies that the folder exists before upload", async () => {
    await insertReceipt();
    const calls: Array<{ method: string; path: string; search: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search });
      if (init?.method === "POST") {
        return Response.json({ File: { Id: "file_1", ArchiveFileId: "archive_1", Path: "Inbox_s" } }, { status: 201 });
      }
      return Response.json({ Folder: { Folders: [{ Id: "inbox_s", Name: "Leverantörsfakturor" }] } });
    }));

    const result = await pushReceiptToFortnoxInbox(workerEnv(), "rcp_test");

    expect(result.reused).toBe(false);
    expect(result.fortnox_file_id).toBe("file_1");
    expect(calls).toEqual([
      { method: "GET", path: "/3/inbox", search: "" },
      { method: "POST", path: "/3/inbox", search: "?folderid=inbox_s" }
    ]);
  });

  it("maps Inbox_s to the Fortnox folder id even when upload is called without a verified folder id", async () => {
    const calls: Array<{ method: string; path: string; search: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search });
      return Response.json({ File: { Id: "file_1", ArchiveFileId: "archive_1", Path: "inbox_s" } }, { status: 201 });
    }));

    await uploadInboxFile(workerEnv(), new File(["test"], "receipt.pdf", { type: "application/pdf" }), FORTNOX_INBOX_PATHS.SUPPLIER_DOCUMENT);

    expect(calls).toEqual([
      { method: "POST", path: "/3/inbox", search: "?folderid=inbox_s" }
    ]);
  });

  it("stores provider ids after the first upload", async () => {
    await insertReceipt();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return Response.json({ File: { Id: "file_1", ArchiveFileId: "archive_1", Path: "Inbox_s" } }, { status: 201 });
      }
      return Response.json({ Folder: { Folders: [{ Id: "inbox_s", Name: "Leverantörsfakturor" }] } });
    }));

    await pushReceiptToFortnoxInbox(workerEnv(), "rcp_test");

    const row = await env.DB.prepare(
      "SELECT fortnox_file_id, fortnox_inbox_file_id, fortnox_archive_file_id, fortnox_inbox_path, pushed_to_fortnox_at, status FROM receipts WHERE id=?"
    ).bind("rcp_test").first<any>();
    expect(row).toMatchObject({
      fortnox_file_id: "file_1",
      fortnox_inbox_file_id: "file_1",
      fortnox_archive_file_id: "archive_1",
      fortnox_inbox_path: "Inbox_s",
      status: "INBOX_UPLOADED"
    });
    expect(row.pushed_to_fortnox_at).toBeTruthy();
  });

  it("reuses an existing remote mapping without uploading again", async () => {
    await insertReceipt({ fortnox_file_id: "file_1", fortnox_inbox_file_id: "file_1", fortnox_inbox_path: "Inbox_s" });
    const calls: Array<{ method: string; path: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? "GET", path: url.pathname });
      return Response.json({ File: { Id: "file_1" } });
    }));

    const result = await pushReceiptToFortnoxInbox(workerEnv(), "rcp_test");

    expect(result).toMatchObject({ reused: true, fortnox_file_id: "file_1", fortnox_inbox_path: "Inbox_s" });
    expect(calls).toEqual([{ method: "GET", path: "/3/inbox/file_1" }]);
  });

  it("does not log remote file contents when verifying an existing mapping", async () => {
    await insertReceipt({ fortnox_file_id: "file_1", fortnox_inbox_file_id: "file_1", fortnox_inbox_path: "Inbox_s" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-1.4 secret file body", {
      status: 200,
      headers: { "content-type": "application/pdf", "content-length": "25" }
    })));

    await pushReceiptToFortnoxInbox(workerEnv(), "rcp_test");

    const row = await env.DB.prepare(
      "SELECT response_json FROM sync_log ORDER BY created_at DESC LIMIT 1"
    ).first<{ response_json: string | null }>();
    expect(row?.response_json).toContain("application/pdf");
    expect(row?.response_json).not.toContain("%PDF");
    expect(row?.response_json).not.toContain("secret file body");
  });

  it("fails in a controlled way when a mapped remote file is missing", async () => {
    await insertReceipt({ fortnox_file_id: "file_1", fortnox_inbox_file_id: "file_1", fortnox_inbox_path: "Inbox_s" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { ErrorInformation: { message: "File not found" } },
      { status: 404 }
    )));

    await expect(pushReceiptToFortnoxInbox(workerEnv(), "rcp_test")).rejects.toMatchObject({
      status: 409,
      publicMessage: "Mapped Fortnox Inbox file not found"
    } satisfies Partial<PublicAppError>);
  });

  it("does not double upload across repeated pushes", async () => {
    await insertReceipt();
    const methods: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      methods.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      if (init?.method === "POST") {
        return Response.json({ File: { Id: "file_1", ArchiveFileId: "archive_1", Path: "Inbox_s" } }, { status: 201 });
      }
      if (url.pathname.endsWith("/file_1")) return Response.json({ File: { Id: "file_1" } });
      return Response.json({ Folder: { Folders: [{ Id: "inbox_s", Name: "Leverantörsfakturor" }] } });
    }));

    await pushReceiptToFortnoxInbox(workerEnv(), "rcp_test");
    await pushReceiptToFortnoxInbox(workerEnv(), "rcp_test");

    expect(methods).toEqual([
      "GET /3/inbox",
      "POST /3/inbox?folderid=inbox_s",
      "GET /3/inbox/file_1"
    ]);
  });
});
