"use client";

import { Badge } from "@workspace/ui/components/badge";
import { Button } from "@workspace/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog";
import { Input } from "@workspace/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select";
import { Spinner } from "@workspace/ui/components/spinner";
import { Textarea } from "@workspace/ui/components/textarea";
import type { LocaleKey } from "@/locales";
import type { MessageTargetMode, UserItem } from "@/lib/features/users/types/user-types";
import { selectContentProps } from "@/lib/features/users/utils/user-utils";

export function UserMessageDialog(props: {
  open: boolean;
  sending: boolean;
  targetMode: MessageTargetMode;
  recipients: UserItem[];
  selectedRecipients: UserItem[];
  filteredRecipients: UserItem[];
  title: string;
  body: string;
  t: (key: LocaleKey) => string;
  onOpenChange: (open: boolean) => void;
  onTargetModeChange: (value: MessageTargetMode) => void;
  onTitleChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onSend: () => void;
}) {
  const {
    open,
    sending,
    targetMode,
    recipients,
    selectedRecipients,
    filteredRecipients,
    title,
    body,
    t,
    onOpenChange,
    onTargetModeChange,
    onTitleChange,
    onBodyChange,
    onSend,
  } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("inbox.composeTitle")}</DialogTitle>
          <DialogDescription>
            {t("inbox.composeDescription").replace("{count}", String(recipients.length))}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{t("inbox.targetMode")}</span>
            <Select value={targetMode} onValueChange={(value) => onTargetModeChange(value as MessageTargetMode)}>
              <SelectTrigger aria-label={t("inbox.targetMode")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent {...selectContentProps()}>
                <SelectItem value="selected">
                  {t("inbox.targetSelected").replace("{count}", String(selectedRecipients.length))}
                </SelectItem>
                <SelectItem value="filtered">
                  {t("inbox.targetFiltered").replace("{count}", String(filteredRecipients.length))}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-xl border bg-muted/20 p-3">
            <div className="text-sm font-medium">{t("inbox.recipients")}</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {recipients.slice(0, 8).map((item) => (
                <Badge key={item.id} variant="outline">
                  {item.username}
                </Badge>
              ))}
              {recipients.length > 8 ? (
                <Badge variant="outline">+{recipients.length - 8}</Badge>
              ) : null}
            </div>
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{t("inbox.messageTitle")}</span>
            <Input
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder={t("inbox.messageTitlePlaceholder")}
              maxLength={120}
            />
          </div>
          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">{t("inbox.messageBody")}</span>
            <Textarea
              value={body}
              onChange={(event) => onBodyChange(event.target.value)}
              placeholder={t("inbox.messageBodyPlaceholder")}
              rows={7}
              maxLength={5000}
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={onSend}
            disabled={sending || recipients.length === 0 || !title.trim() || !body.trim()}
          >
            {sending ? <Spinner className="size-4" /> : t("inbox.send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
