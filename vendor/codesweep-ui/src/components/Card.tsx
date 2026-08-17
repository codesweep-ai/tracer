import { Maximize2, Minimize2 } from "lucide-react";
import { cn } from "../lib/cn";
import { useCardGroup } from "./CardGroupContext";
import { Skeleton } from "./Skeleton";

interface CardProps {
  header?: React.ReactNode;
  children: React.ReactNode;
  variant?: "default" | "muted" | "success" | "danger" | "tight";
  className?: string;
  id?: string;
  maximizable?: boolean;
  /** Loading state: replace card body with skeleton lines (header preserved). Added v1.2.0. */
  loading?: boolean;
}

const variantStyles: Record<string, string> = {
  default: "bg-[var(--card)] border-[var(--border)] p-[var(--space-4)]",
  muted: "bg-[var(--color-bg-muted)] border-[var(--border)] p-[var(--space-4)]",
  success:
    "bg-[var(--color-success-bg)] border-[var(--color-success)] p-[var(--space-4)]",
  danger:
    "bg-[var(--color-error-bg)] border-[var(--color-error)] p-[var(--space-4)]",
  tight: "bg-[var(--card)] border-[var(--border)] p-[var(--space-3)]",
};

export function Card({
  header,
  children,
  variant = "default",
  className,
  id,
  maximizable,
  loading,
}: CardProps) {
  const group = useCardGroup();

  const isMaximizable = !!group && !!id && !!maximizable;
  const isMaximized = isMaximizable && group.maximizedId === id;
  const isHidden = !!group && !!id && group.maximizedId !== null && group.maximizedId !== id;

  if (isHidden) {
    return <div data-component="Card" className="hidden" />;
  }

  const Icon = isMaximized ? Minimize2 : Maximize2;

  // Flex-fill the group's height only when the group is filling, or when this
  // card is maximized. In a natural-stack group (fill={false}), unmaximized
  // cards size to their content and the page scrolls.
  const fillCard = !!group && (group.fill || isMaximized);

  return (
    <div
      data-component="Card"
      className={cn(
        "border rounded-[var(--radius-md)] [box-shadow:var(--shadow-sm)] overflow-hidden",
        variantStyles[variant],
        header && "p-0",
        fillCard && "flex-1 min-h-0 flex flex-col",
        className
      )}
    >
      {header && (
        <div
          className={cn(
            "px-[var(--space-4)] py-[var(--space-3)] border-b border-[var(--border)] bg-[var(--bg)] [font-size:var(--font-size-card-header)] [font-weight:var(--font-weight-semibold)]",
            isMaximizable && "flex items-center justify-between"
          )}
        >
          <span>{header}</span>
          {isMaximizable && (
            <button
              onClick={() => group.toggle(id)}
              className="p-[var(--space-1)] rounded-[var(--radius-sm)] [color:var(--muted)] hover:[color:var(--fg)] hover:bg-[var(--color-bg-muted-hover)] transition-colors"
              aria-label={isMaximized ? "Minimize" : "Maximize"}
            >
              <Icon className="w-[var(--icon-size-sm)] h-[var(--icon-size-sm)]" />
            </button>
          )}
        </div>
      )}
      {header ? (
        <div
          className={cn(
            variant === "tight" ? "p-[var(--space-3)]" : "p-[var(--space-4)]",
            fillCard && "flex-1 min-h-0 overflow-y-auto",
            isMaximized && "flex flex-col"
          )}
        >
          {loading ? <CardSkeletonBody /> : children}
        </div>
      ) : loading ? (
        <div className="p-[var(--space-4)]">
          <CardSkeletonBody />
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function CardSkeletonBody() {
  return (
    <div
      data-testid="card-loading"
      className="flex flex-col gap-[var(--space-2)]"
    >
      <Skeleton variant="text" width="80%" />
      <Skeleton variant="text" width="65%" />
      <Skeleton variant="text" width="75%" />
    </div>
  );
}
