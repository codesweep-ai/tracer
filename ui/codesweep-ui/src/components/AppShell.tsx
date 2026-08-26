import { cn } from "../lib/cn";

interface NavItem {
  label: string;
  href: string;
  active?: boolean;
  /** Optional group key — a separator is rendered between adjacent items with different groups. */
  group?: string;
  onClick?: (e: React.MouseEvent<HTMLAnchorElement>) => void;
}

interface HeaderProps {
  logoSrc?: string;
  title: string;
  navItems?: NavItem[];
  actions?: React.ReactNode;
}

interface FooterProps {
  children?: React.ReactNode;
}

interface AppShellProps {
  children: React.ReactNode;
}

export function Header({ logoSrc, title, navItems, actions }: HeaderProps) {
  return (
    <header
      data-component="Header"
      className="sticky top-0 z-[var(--z-header)] bg-[var(--color-header-bg)] [color:var(--color-header-text)] [box-shadow:var(--shadow-header)]"
    >
      <div className="px-[var(--space-4)] py-[var(--space-3)] flex items-center justify-between max-md:flex-col max-md:items-start max-md:gap-[var(--space-2)]">
        <a href="/" className="flex items-center gap-[var(--space-2)] no-underline">
          {logoSrc ? (
            <img src={logoSrc} alt={title} className="h-8 w-auto" />
          ) : (
            <span className="[color:var(--color-brand)] [font-weight:var(--font-weight-bold)] [font-size:var(--font-size-lg)]">
              {title}
            </span>
          )}
        </a>
        <nav role="navigation" aria-label="Main navigation">
          <div className="flex items-center gap-[var(--space-1)] max-md:flex-wrap">
            {navItems?.map((item, i) => {
              const prevGroup = i > 0 ? navItems[i - 1].group : undefined;
              const showSeparator = item.group && prevGroup && item.group !== prevGroup;
              return (
                <span key={item.href} className="flex items-center">
                  {showSeparator && (
                    <span
                      className="h-4 mx-[var(--space-2)] border-l border-[var(--color-nav-hover)]"
                      aria-hidden="true"
                    />
                  )}
                  <a
                    href={item.href}
                    aria-current={item.active ? "page" : undefined}
                    className={cn(
                      "px-[var(--space-3)] py-[var(--space-2)] [font-size:var(--font-size-xs)] [font-weight:var(--font-weight-medium)] rounded-[var(--radius-sm)] no-underline transition-colors",
                      item.active
                        ? "[color:var(--color-header-text-active)] bg-[var(--color-nav-hover)]"
                        : "[color:var(--color-header-text-muted)] hover:[color:var(--color-text-inverse)] hover:bg-[var(--color-nav-hover)]"
                    )}
                    onClick={(e) => {
                      e.preventDefault();
                      item.onClick?.(e);
                    }}
                  >
                    {item.label}
                  </a>
                </span>
              );
            })}
            {actions}
          </div>
        </nav>
      </div>
    </header>
  );
}

export function Footer({ children }: FooterProps) {
  return (
    <footer
      data-component="Footer"
      className="bg-[var(--color-header-bg)] [color:var(--color-header-text)] px-[var(--space-4)] py-[var(--space-3)] text-center [font-size:var(--font-size-xs)] mt-auto [box-shadow:var(--shadow-up)]"
    >
      {children || `© codesweep.ai ${new Date().getFullYear()}`}
    </footer>
  );
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div data-component="AppShell" className="h-screen flex flex-col overflow-hidden bg-[var(--bg)] [color:var(--fg)]">
      {children}
    </div>
  );
}
