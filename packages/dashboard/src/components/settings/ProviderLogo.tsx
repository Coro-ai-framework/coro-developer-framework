import { Plug } from 'lucide-react'
import { cn } from '../../lib/utils'

// Brand glyphs sourced from Simple Icons (CC0). Monochrome, single-path,
// currentColor — we tint them per-provider so the row is instantly
// recognisable without relying on full-colour PNGs.
//
// Adding a new provider: drop another entry into PROVIDER_PATHS keyed by
// the plugin id and pick a tint class. Unknown plugin ids fall back to
// the generic `Plug` icon.

interface BrandIcon {
  /** SVG path data (single <path d="...">) */
  path: string
  /** Tailwind text-color class for the brand tint. */
  tint: string
}

const PROVIDER_PATHS: Record<string, BrandIcon> = {
  github: {
    path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
    tint: 'text-fg',
  },
  bitbucket: {
    path: 'M.778 1.213a.768.768 0 00-.768.892l3.263 19.81c.084.5.515.868 1.022.873H19.95a.772.772 0 00.77-.646l3.27-20.03a.768.768 0 00-.768-.891zM14.52 15.53H9.522L8.17 8.466h7.561z',
    tint: 'text-[#2684FF]',
  },
  gitlab: {
    path: 'm23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.875.875 0 0 0-.9997.0539.875.875 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.857.857 0 0 0-.29-.4412.875.875 0 0 0-.9997-.0537.859.859 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z',
    tint: 'text-[#FC6D26]',
  },
  jira: {
    path: 'M11.571 11.513H0a5.218 5.218 0 0 0 5.232 5.215h2.13v2.057A5.215 5.215 0 0 0 12.575 24V12.518a1.005 1.005 0 0 0-1.005-1.005zm5.723-5.756H5.736a5.215 5.215 0 0 0 5.215 5.214h2.129v2.058a5.218 5.218 0 0 0 5.215 5.214V6.762a1.005 1.005 0 0 0-1.001-1.005zM23.013 0H11.455a5.215 5.215 0 0 0 5.215 5.215h2.129v2.057A5.215 5.215 0 0 0 24 12.483V1.005A1.005 1.005 0 0 0 23.013 0z',
    tint: 'text-[#2684FF]',
  },
  linear: {
    path: 'M.403 13.795A12.0073 12.0073 0 0 0 10.205 23.597zM.0093 10.6066L13.3935 23.9908a12.0676 12.0676 0 0 0 2.2914-.4634L.4727 8.3151a12.0676 12.0676 0 0 0-.4634 2.2915zm1.0186-3.7156L16.4283 22.5478a12.0728 12.0728 0 0 0 1.821-1.0354L2.5494 5.8639A12.0728 12.0728 0 0 0 1.0279 6.891zm2.4998-3.013a12 12 0 1 1 16.9744 16.9744L3.5277 3.878z',
    tint: 'text-[#5E6AD2]',
  },
  'github-issues': {
    // Reuse the GitHub mark.
    path: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
    tint: 'text-fg',
  },
}

interface ProviderLogoProps {
  pluginId: string
  className?: string
  /** Pixel size; default 20. */
  size?: number
}

/**
 * Render a brand glyph for a known plugin id. Falls back to the generic
 * `Plug` icon for drop-in plugins we don't yet have a brand mark for.
 */
export default function ProviderLogo({ pluginId, className, size = 20 }: ProviderLogoProps) {
  const brand = PROVIDER_PATHS[pluginId]
  if (!brand) {
    return <Plug aria-hidden className={cn('text-fg-subtle', className)} style={{ width: size, height: size }} />
  }
  return (
    <svg
      role="img"
      aria-label={pluginId}
      viewBox="0 0 24 24"
      className={cn(brand.tint, className)}
      style={{ width: size, height: size }}
      fill="currentColor"
    >
      <path d={brand.path} />
    </svg>
  )
}
