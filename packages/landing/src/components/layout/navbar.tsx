import { navigation } from '../../content/landing'
import { BrandMark } from '../brand-mark'
import { Button } from '../ui/button'

export function Navbar() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-canvas/70 backdrop-blur-2xl">
      <nav className="mx-auto flex h-20 max-w-7xl items-center justify-between px-6 sm:px-8">
        <a href="#" aria-label="Coro home">
          <BrandMark />
        </a>
        <div className="hidden items-center gap-7 md:flex">
          {navigation.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-sm font-medium text-fg-muted transition hover:text-fg"
            >
              {item.label}
            </a>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <Button href="#" variant="ghost" size="sm" className="hidden sm:inline-flex">
            Log in
          </Button>
          <Button href="#modes" size="sm">
            Get started
          </Button>
        </div>
      </nav>
    </header>
  )
}
