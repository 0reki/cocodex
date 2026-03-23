export function getBackendBaseUrl() {
  const configured = process.env.BACKEND_BASE_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "BACKEND_BASE_URL is required in production. Please set it to your backend domain URL.",
    );
  }

  return "http://localhost:53141";
}
