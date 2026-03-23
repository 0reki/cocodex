export type InboxMessage = {
  id: string;
  senderUsername: string | null;
  title: string;
  body: string;
  aiTranslated: boolean;
  readAt: string | null;
  createdAt: string;
};
