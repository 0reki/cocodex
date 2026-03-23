export type ApiKeyRecord = {
  id: string;
  name: string;
  apiKey: string;
  quota: number | null;
  used: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApiKeysResponse = {
  items?: ApiKeyRecord[];
  count?: number;
  error?: string;
};
