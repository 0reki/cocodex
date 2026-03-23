const EMAIL_FIRST_NAMES = [
  "alex",
  "amelia",
  "anna",
  "ava",
  "ben",
  "caleb",
  "chloe",
  "daniel",
  "david",
  "ella",
  "emma",
  "ethan",
  "evan",
  "ezra",
  "grace",
  "hannah",
  "henry",
  "isla",
  "jack",
  "jacob",
  "james",
  "leo",
  "liam",
  "lily",
  "lucas",
  "lucy",
  "mason",
  "mia",
  "nathan",
  "noah",
  "nora",
  "oliver",
  "olivia",
  "owen",
  "sam",
  "sara",
  "scarlett",
  "sophia",
  "thomas",
  "william",
  "zoe",
] as const

const EMAIL_LAST_NAMES = [
  "adams",
  "allen",
  "baker",
  "barnes",
  "bell",
  "brooks",
  "carter",
  "clark",
  "cole",
  "cooper",
  "davis",
  "edwards",
  "evans",
  "fisher",
  "foster",
  "gray",
  "green",
  "hall",
  "harris",
  "hayes",
  "hill",
  "jackson",
  "king",
  "lee",
  "lewis",
  "long",
  "moore",
  "morris",
  "parker",
  "perry",
  "price",
  "reed",
  "ross",
  "scott",
  "taylor",
  "turner",
  "ward",
  "watson",
  "west",
  "white",
  "young",
] as const

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)] as T
}

export function generateReadableEmailLocalPart(): string {
  const first = pickRandom(EMAIL_FIRST_NAMES)
  const last = pickRandom(EMAIL_LAST_NAMES)
  const suffix = Math.floor(Math.random() * 100)
    .toString()
    .padStart(2, "0")
  return `${first}${last}${suffix}`
}

export function createReadableCloudMailAddress(domain: string): string {
  const normalizedDomain = domain.trim().toLowerCase()
  if (!normalizedDomain) {
    throw new Error("domain is required")
  }
  return `${generateReadableEmailLocalPart()}@${normalizedDomain}`
}
