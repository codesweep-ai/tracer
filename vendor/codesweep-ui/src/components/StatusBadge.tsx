import { cn } from "../lib/cn";

interface StatusBadgeProps {
  label: string;
  status: "success" | "warning" | "error" | "neutral";
  full?: boolean;
  className?: string;
}

const dotColors: Record<string, string> = {
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  error: "var(--color-error)",
  neutral: "var(--color-neutral)",
};

export function StatusBadge({
  label,
  status,
  full,
  className,
}: StatusBadgeProps) {
  return (
    <span
      data-component="StatusBadge"
      role="status"
      aria-label={`${label}: ${status}`}
      className={cn(
        "inline-flex items-center gap-[var(--space-2)]",
        "border border-[var(--border)] rounded-[var(--radius-sm)]",
        "px-[var(--space-2)] py-[var(--space-1)]",
        full && "w-full",
        className
      )}
    >
      <span
        className="w-[var(--space-2)] h-[var(--space-2)] rounded-full flex-shrink-0"
        style={{ backgroundColor: dotColors[status] }}
        aria-hidden="true"
      />
      <span className="text-label-upper truncate">
        {label}
      </span>
    </span>
  );
}
