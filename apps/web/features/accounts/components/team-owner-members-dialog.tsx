"use client";

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
import { Spinner } from "@workspace/ui/components/spinner";
import type { LocaleKey } from "@/locales";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table";
import type { TeamOwnerMemberItem } from "@/lib/features/accounts/types/account-types";

export function TeamOwnerMembersDialog(props: {
  open: boolean;
  ownerEmail: string;
  loading: boolean;
  error: string | null;
  items: TeamOwnerMemberItem[];
  inviteEmail: string;
  inviteSubmitting: boolean;
  removingEmail: string | null;
  t: (key: LocaleKey) => string;
  normalizeRole: (role: string | null) => string;
  normalizeStatus: (status: string | null) => string;
  onOpenChange: (open: boolean) => void;
  onInviteEmailChange: (value: string) => void;
  onInvite: () => void;
  onRemove: (member: TeamOwnerMemberItem) => void;
}) {
  const {
    open,
    ownerEmail,
    loading,
    error,
    items,
    inviteEmail,
    inviteSubmitting,
    removingEmail,
    t,
    normalizeRole,
    normalizeStatus,
    onOpenChange,
    onInviteEmailChange,
    onInvite,
    onRemove,
  } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[96vw] max-w-[96vw] sm:max-w-[1100px]">
        <DialogHeader>
          <DialogTitle>团队成员</DialogTitle>
          <DialogDescription>
            {ownerEmail ? `${ownerEmail} 的当前成员列表` : "当前成员列表"}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] overflow-auto rounded-lg border">
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
              <Spinner className="size-4" />
              <span>{t("common.loading")}</span>
            </div>
          ) : error ? (
            <div className="px-4 py-6 text-sm text-destructive">{error}</div>
          ) : items.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">暂无成员</div>
          ) : (
            <Table className="min-w-[920px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[320px] px-3 py-3">{t("common.email")}</TableHead>
                  <TableHead className="min-w-[180px] px-3 py-3">{t("common.name")}</TableHead>
                  <TableHead className="min-w-[160px] px-3 py-3">角色</TableHead>
                  <TableHead className="min-w-[100px] px-3 py-3">{t("common.status")}</TableHead>
                  <TableHead className="min-w-[100px] px-3 py-3 text-right">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((member) => (
                  <TableRow key={`${member.id}:${member.email}`} className="border-t">
                    <TableCell className="px-3 py-3">{member.email || "-"}</TableCell>
                    <TableCell className="px-3 py-3">{member.name || "-"}</TableCell>
                    <TableCell className="px-3 py-3">{normalizeRole(member.role)}</TableCell>
                    <TableCell className="px-3 py-3">{normalizeStatus(member.status)}</TableCell>
                    <TableCell className="px-3 py-3 text-right">
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={removingEmail === member.email}
                        onClick={() => onRemove(member)}
                      >
                        {removingEmail === member.email ? (
                          <Spinner className="size-4" />
                        ) : (
                          t("common.remove")
                        )}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
        <div>
          <div className="mb-2 text-sm font-medium">邀请用户</div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={inviteEmail}
              onChange={(event) => onInviteEmailChange(event.target.value)}
              placeholder="输入邮箱后发送邀请"
              className="h-8"
            />
            <Button onClick={onInvite} disabled={inviteSubmitting || !inviteEmail.trim()}>
              {inviteSubmitting ? <Spinner className="size-4" /> : "发送邀请"}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
