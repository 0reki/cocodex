function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value ? value : undefined
}

function readRequiredEnv(name: string): string {
  const value = readEnv(name)
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

export function getCloudMailBaseUrl(): string {
  return readRequiredEnv("CLOUD_MAIL_BASE_URL")
}

export function getCloudMailAuthorization(): string {
  return readRequiredEnv("CLOUD_MAIL_AUTHORIZATION")
}

export function getCloudMailDefaultBaseUrl(): string {
  return getCloudMailBaseUrl()
}

export function getCloudMailDefaultAuthorization(): string {
  return getCloudMailAuthorization()
}
