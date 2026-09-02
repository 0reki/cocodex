import { ArrowLeft } from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/ui/components/button";

export function NotFoundPage() {
  return (
    <main className="grid min-h-full place-items-center px-4 py-16 text-center">
      <div className="grid justify-items-center gap-3">
        <span className="text-sm font-medium tracking-widest text-muted-foreground">
          404
        </span>
        <h1 className="text-2xl font-bold">这里没有内容</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          路由可能已经移动，或不属于当前精简版控制台。
        </p>
        <Button asChild className="mt-2">
          <Link to="/dashboard">
            <ArrowLeft /> 返回仪表盘
          </Link>
        </Button>
      </div>
    </main>
  );
}
