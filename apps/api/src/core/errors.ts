export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}
export class BackendRejectedError extends AppError {
  constructor(message: string) {
    super("BACKEND_REJECTED", message, 502);
  }
}
export class BackendBusyError extends AppError {
  constructor() {
    super("BACKEND_BUSY", "115 RSS 任务仍在运行，本次尚未提交；请稍后继续确认。", 503);
  }
}
export class UnknownSubmissionError extends AppError {
  constructor() {
    super("SUBMISSION_UNKNOWN", "提交结果不确定，请核对后端任务；服务不会自动重复提交。", 502);
  }
}
export class ConflictError extends AppError {
  constructor(message: string) {
    super("CONFLICT", message, 409);
  }
}
export class NotFoundError extends AppError {
  constructor(message: string) {
    super("NOT_FOUND", message, 404);
  }
}
