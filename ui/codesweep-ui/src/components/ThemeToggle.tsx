import { Sun, Moon, Monitor } from "lucide-react";
import { cn } from "../lib/cn";
import { useTheme } from "../lib/useTheme";

interface ThemeToggleProps {
  variant?: "icon-cycle" | "radio-group";
  className?: string;
}

export function ThemeToggle({
  variant = "icon-cycle",
  className,
}: ThemeToggleProps) {
  const { mode, resolved, setMode, cycle } = useTheme();

  if (variant === "radio-group") {
    const options: { value: "light" | "dark" | "system"; label: string }[] = [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
      {
        value: "system",
        label: `System (${resolved === "dark" ? "Dark" : "Light"})`,
      },
    ];

    return (
      <div
        data-component="ThemeToggle"
        role="radiogroup"
        aria-label="Theme"
        className={cn("inline-flex gap-[var(--space-1)] items-center", className)}
      >
        {options.map((opt) => (
          <button
            key={opt.value}
            role="radio"
            aria-checked={mode === opt.value}
            onClick={() => setMode(opt.value)}
            className={cn(
              "px-[var(--space-2)] py-[var(--space-1)] rounded-[var(--radius-sm)] [font-size:var(--font-size-xs)] transition-colors cursor-pointer",
              mode === opt.value
                ? "bg-[var(--color-bg-muted)] [color:var(--fg)]"
                : "bg-transparent [color:var(--muted)] hover:[color:var(--fg)]"
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
    );
  }

  const Icon = mode === "light" ? Sun : mode === "dark" ? Moon : Monitor;

  return (
    <button
      data-component="ThemeToggle"
      onClick={cycle}
      className={cn(
        "inline-flex items-center justify-center p-[var(--space-2)]",
        "border border-[var(--border)] rounded-[var(--radius-md)]",
        "bg-transparent [color:var(--color-header-text)]",
        "hover:bg-[var(--color-nav-hover)] hover:border-[var(--muted)]",
        "active:scale-95 transition-all cursor-pointer",
        "focus:outline-none focus:ring-2 focus:ring-[var(--color-brand-accent)]",
        className
      )}
      aria-label={`Toggle theme. Current: ${mode}`}
      title={`Theme: ${mode}. Click to cycle.`}
    >
      <Icon className="w-[var(--icon-size-lg)] h-[var(--icon-size-lg)]" />
    </button>
  );
}
