import type { getPortalUserSpendAllowance } from "../../database/index.ts";

export type PortalUserSpendAllowanceValue = Awaited<
  ReturnType<typeof getPortalUserSpendAllowance>
>;
