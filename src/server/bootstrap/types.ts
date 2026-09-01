import type {
  ApiKeyRecord,
  getPortalUserSpendAllowance,
} from "../../database/index.ts";

export type PortalUserSpendAllowanceValue = Awaited<
  ReturnType<typeof getPortalUserSpendAllowance>
>;

export type ApiKeysCacheState = {
  loaded: boolean;
  items: ApiKeyRecord[];
  byToken: Map<string, ApiKeyRecord[]>;
  loadingPromise: Promise<void> | null;
};
