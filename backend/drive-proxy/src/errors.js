export function httpError(status, code, message, details) {
  const err = new Error(message || code || "error");
  err.status = status || 500;
  err.code = code || "ERROR";
  if (details !== undefined) err.details = details;
  return err;
}
