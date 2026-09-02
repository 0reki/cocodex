export type UsdAmount = bigint;

const USD_SCALE = 8;
const USD_SCALE_FACTOR = 100_000_000n;

function roundDivide(value: bigint, divisor: bigint) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const quotient = absolute / divisor;
  const remainder = absolute % divisor;
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

export function parseUsdAmount(value: unknown): UsdAmount | null {
  if (
    !(
      typeof value === "string" ||
      (typeof value === "number" && Number.isFinite(value))
    )
  ) {
    return null;
  }
  const normalized = String(value).trim();
  const match = normalized.match(
    /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/,
  );
  if (!match) return null;

  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return null;

  const coefficient = BigInt(`${match[2]}${fraction}`);
  const signedCoefficient = match[1] === "-" ? -coefficient : coefficient;
  const sourceScale = fraction.length - exponent;
  const scaleDifference = USD_SCALE - sourceScale;
  if (scaleDifference >= 0) {
    return signedCoefficient * 10n ** BigInt(scaleDifference);
  }
  return roundDivide(
    signedCoefficient,
    10n ** BigInt(-scaleDifference),
  );
}

export function formatUsdAmount(value: UsdAmount): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / USD_SCALE_FACTOR;
  const fraction = (absolute % USD_SCALE_FACTOR)
    .toString()
    .padStart(USD_SCALE, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function divideUsdAmount(
  value: UsdAmount,
  divisor: bigint,
): UsdAmount {
  if (divisor <= 0n) throw new Error("USD divisor must be positive");
  return roundDivide(value, divisor);
}
