export type CopyState = "IDLE" | "COPIED" | "MANUAL";

type ClipboardLike = {
  writeText?: (value: string) => Promise<void>;
};

export async function copyTextToClipboard(value: string, clipboard: ClipboardLike | null | undefined = globalThis.navigator?.clipboard): Promise<CopyState> {
  if (!value || !clipboard?.writeText) return "MANUAL";
  try {
    await clipboard.writeText(value);
    return "COPIED";
  } catch {
    return "MANUAL";
  }
}

export function copyFeedbackText(state: CopyState): string {
  if (state === "COPIED") return "Länken kopierad.";
  if (state === "MANUAL") return "Markera och kopiera länken manuellt.";
  return "";
}
