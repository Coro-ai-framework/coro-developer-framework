import { footerLinks } from '../../content/landing'
import { BrandMark } from '../brand-mark'

export function Footer() {
  return (
    <footer className="border-t border-line bg-canvas-deep/80">
      <div className="mx-auto grid max-w-7xl gap-10 px-6 py-12 sm:px-8 lg:grid-cols-[1.4fr_2fr]">
        <div>
          <BrandMark />
          <p className="mt-5 max-w-md text-sm leading-7 text-fg-muted">
            The plug-and-play AI harness for deterministic software engineering workflows,
            from free solo runs to collaborative team execution.
          </p>
        </div>
        <div className="grid gap-8 sm:grid-cols-3">
          {footerLinks.map((group) => (
            <div key={group.title}>
              <h3 className="text-sm font-semibold text-fg">{group.title}</h3>
              <ul className="mt-4 space-y-3">
                {group.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-sm text-fg-muted transition hover:text-fg"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="mx-auto flex max-w-7xl items-center justify-between border-t border-line px-6 py-6 text-xs text-fg-subtle sm:px-8">
        <span>© {new Date().getFullYear()} Coro.</span>
        <span>Markdown intelligence. Deterministic runs.</span>
      </div>
    </footer>
  )
}
