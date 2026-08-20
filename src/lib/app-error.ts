import { id } from "./db";

export class PublicAppError extends Error {
  constructor(
    public readonly status: number,
    public readonly publicMessage: string,
    public readonly requestId = id("err")
  ) {
    super(publicMessage);
  }
}
