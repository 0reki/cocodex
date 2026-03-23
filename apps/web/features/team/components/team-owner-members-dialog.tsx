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
import type { TeamOwnerMemberItem } from "@/lib/features/team/types/team-types";
import { LocalDateTime } from "@/lib/features/team/utils/team-utils";

export function TeamOwnerMembersDialog(props: {
  open: boolean;
  email: string;
  loading: boolean;
  error: string | null;
  items: TeamOwnerMemberItem[];
  t: (key: LocaleKey) => string;
  onOpenChange: (open: boolean) => void;
}) {
  const { open, email, loading, error, items, t, onOpenChange } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>团队成员</DialogTitle>
          <DialogDescription>
            {email ? `${email} 的当前成员列表` : "当前成员列表"}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto rounded-lg border">
          {loading ? (
            <div className="flex items-center justify-center gap-2 px-4 py-10 text-sm text-muted-foreground">
              <Spinner />
              <span>{t("common.loading")}</span>
            </div>
          ) : error ? (
            <div className="px-4 py-6 text-sm text-destructive">{error}</div>
          ) : items.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">暂无成员</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 text-left">
                  <TableHead className="px-3 py-3 font-medium">{t("common.email")}</TableHead>
                  <TableHead className="px-3 py-3 font-medium">{t("common.name")}</TableHead>
                  <TableHead className="px-3 py-3 font-medium">Role</TableHead>
                  <TableHead className="px-3 py-3 font-medium">Seat</TableHead>
                  <TableHead className="px-3 py-3 font-medium">{t("common.status")}</TableHead>
                  <TableHead className="px-3 py-3 font-medium">{t("common.createdAt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((member) => (
                  <TableRow key={`${member.id}:${member.email}`} className="border-t">
                    <TableCell className="px-3 py-3">{member.email || "-"}</TableCell>
                    <TableCell className="px-3 py-3">{member.name || "-"}</TableCell>
                    <TableCell className="px-3 py-3">{member.role || "-"}</TableCell>
                    <TableCell className="px-3 py-3">{member.seatType || "-"}</TableCell>
                    <TableCell className="px-3 py-3">
                      {member.deactivatedTime ? "disabled" : "active"}
                    </TableCell>
                    <TableCell className="px-3 py-3">
                      <LocalDateTime value={member.createdTime} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
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
