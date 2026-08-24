import { describe, expect, it, vi } from "vitest";
import { copyFeedbackText, copyTextToClipboard } from "../src/lib/clipboard";
import mainSource from "../src/main.tsx?raw";

describe("clipboard-safe link handling", () => {
  it("keeps resource creation independent from clipboard availability", () => {
    expect(mainSource).toContain("Kundlänken är redo");
    const createLinkBody = mainSource.match(/async function createLink\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(createLinkBody).toContain("setCustomerLink(link)");
    expect(createLinkBody).not.toContain("navigator.clipboard");
    expect(createLinkBody).not.toContain("copyTextToClipboard");
  });

  it("does not use direct clipboard calls in business-critical handlers", () => {
    expect(mainSource).not.toContain("navigator.clipboard");
  });

  it("returns manual-copy state when Clipboard API is missing", async () => {
    await expect(copyTextToClipboard("https://example.test/link", undefined)).resolves.toBe("MANUAL");
  });

  it("returns manual-copy state when writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    await expect(copyTextToClipboard("https://example.test/link", { writeText })).resolves.toBe("MANUAL");
    expect(copyFeedbackText("MANUAL")).toBe("Markera och kopiera länken manuellt.");
  });

  it("returns positive feedback when explicit copy succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    await expect(copyTextToClipboard("https://example.test/link", { writeText })).resolves.toBe("COPIED");
    expect(writeText).toHaveBeenCalledWith("https://example.test/link");
    expect(copyFeedbackText("COPIED")).toBe("Länken kopierad.");
  });
});
