function requireConfiguredMailProvider(): never {
  throw new Error(
    "mailProvider must be configured explicitly. Pass a mailProvider to runSignupFlow/runSignupBatch.",
  )
}

export async function generateTempEmail(): Promise<string> {
  return requireConfiguredMailProvider()
}

export async function waitForTempEmailOtp(): Promise<string> {
  return requireConfiguredMailProvider()
}
