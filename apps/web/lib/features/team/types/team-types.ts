export type TeamTab = "owner" | "member";

export type ConfirmDialogState = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  confirmVariant?: "default" | "destructive" | "outline";
  action: null | (() => Promise<void>);
};

export type TeamOwnerMemberItem = {
  id: string;
  email: string;
  role: string | null;
  seatType: string | null;
  name: string | null;
  createdTime: string | null;
  deactivatedTime: string | null;
};

export type TeamOwnerFillState = {
  availableSlots: number;
  missingMembers: number;
};
