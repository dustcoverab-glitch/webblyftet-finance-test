import type { SigningProvider } from "./types";

export const basicAcceptanceSigningProvider: SigningProvider = {
  sign(input) {
    return {
      provider: "BASIC_ACCEPTANCE",
      signing_request_id: `basic:${input.session_id}`,
      evidence_reference: [
        "basic-acceptance",
        input.session_id,
        input.document_hash.slice(0, 16),
        input.signer_email.toLowerCase()
      ].join(":")
    };
  }
};
