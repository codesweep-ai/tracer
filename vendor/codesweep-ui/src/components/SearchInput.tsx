import { useEffect, useRef, useCallback } from "react";
import { Search, X } from "lucide-react";
import { cn } from "../lib/cn";

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onSearch: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Min characters before auto-search fires. 0 = no auto-search (manual only). Default: 0 */
  minChars?: number;
  /** Debounce delay in ms for auto-search. Default: 300 */
  debounceMs?: number;
  className?: string;
  /**
   * When true, render a "no results" message inline below the input.
   * Consumers set this based on their search result state. Default: false.
   * Added v1.2.0.
   */
  noResults?: boolean;
  /** Message shown when noResults=true. Default: "No results." */
  noResultsMessage?: string;
}

export function SearchInput({
  value,
  onChange,
  onSearch,
  placeholder = "Search...",
  disabled = false,
  minChars = 0,
  debounceMs = 300,
  className,
  noResults = false,
  noResultsMessage = "No results.",
}: SearchInputProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Auto-search with debounce
  useEffect(() => {
    if (minChars <= 0) return;
    clearTimer();

    if (value.length >= minChars) {
      timerRef.current = setTimeout(() => {
        onSearch(value);
      }, debounceMs);
    }

    return clearTimer;
  }, [value, minChars, debounceMs, onSearch, clearTimer]);

  const handleClear = () => {
    onChange("");
    onSearch("");
    inputRef.current?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      clearTimer();
      onSearch(value);
    } else if (e.key === "Escape") {
      handleClear();
    }
  };

  return (
    <div
      data-component="SearchInput"
      className={cn(
        "inline-flex flex-col",
        disabled && "opacity-50 cursor-not-allowed",
        className,
      )}
    >
    <div
      className={cn(
        "inline-flex items-center",
        "border border-[var(--border)] rounded-[var(--radius-sm)]",
        "bg-[var(--card)]",
        "focus-within:ring-2 focus-within:ring-[var(--color-brand-accent)]",
        "hover:border-[var(--muted)]",
        "transition-colors",
      )}
    >
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        className={cn(
          "flex-1 min-w-0",
          "bg-transparent border-none",
          "px-[var(--space-3)] py-[var(--space-2)]",
          "[font-size:var(--font-size-sm)] [color:var(--fg)]",
          "placeholder:[color:var(--muted)]",
          "focus:outline-none",
          disabled && "cursor-not-allowed"
        )}
      />
      {value.length > 0 && (
        <button
          type="button"
          onClick={handleClear}
          disabled={disabled}
          className={cn(
            "flex-shrink-0 flex items-center justify-center",
            "px-[var(--space-2)] [color:var(--muted)]",
            "bg-transparent border-none",
            "hover:[color:var(--fg)] transition-colors cursor-pointer",
            disabled && "cursor-not-allowed pointer-events-none"
          )}
          aria-label="Clear search"
        >
          <X className="w-[var(--icon-size-md)] h-[var(--icon-size-md)]" />
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          clearTimer();
          onSearch(value);
        }}
        disabled={disabled}
        className={cn(
          "flex-shrink-0 flex items-center justify-center",
          "px-[var(--space-2)] [color:var(--muted)]",
          "bg-transparent border-none",
          "hover:[color:var(--fg)] transition-colors cursor-pointer",
          disabled && "cursor-not-allowed pointer-events-none"
        )}
        aria-label="Search"
      >
        <Search className="w-[var(--icon-size-md)] h-[var(--icon-size-md)]" />
      </button>
    </div>
      {noResults && value.length > 0 && (
        <span
          data-testid="searchinput-noresults"
          className="[font-size:var(--font-size-xs)] [color:var(--muted)] italic mt-[var(--space-1)]"
        >
          {noResultsMessage}
        </span>
      )}
    </div>
  );
}
