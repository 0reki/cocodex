export type UserItem = {
  id: string;
  username: string;
  role: "admin" | "user";
  enabled: boolean;
  userRpmLimit: number | null;
  userMaxInFlight: number | null;
  balance: number;
  createdAt: string;
  updatedAt: string;
};

export type BatchAction = "enable" | "disable" | "delete";

export type UserRoleFilter = "all" | "admin" | "user";
export type UserStatusFilter = "all" | "enabled" | "disabled";
export type UserEditStatus = "enabled" | "disabled";
export type BalanceMode = "set" | "adjust";
export type MessageTargetMode = "selected" | "filtered";
