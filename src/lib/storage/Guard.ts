/** Thrown when input fails validation; `field` names the offending value. `vars` carries extra values for the translated message, such as the allowed weekdays. */
export type ValidationKind = "required" | "tooLong" | "invalid" | "notScheduledDay" | "unqualifiedTrainer" | "overCapacity" | "notEnrolled" | "notAssigned";

export class ValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
    public readonly kind: ValidationKind = "invalid",
    public readonly limit?: number,
    public readonly vars?: Record<string, string | number>,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}
