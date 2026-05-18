import * as React from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from '../../lib/utils'

function Tabs({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root className={cn('flex flex-col gap-4', className)} {...props} />
}

/**
 * Underline-style tab list, visually consistent with the rest of the
 * Coro dashboard surfaces (cards, control bar). Inactive tabs are
 * muted; the active tab is identified by an accent underline that
 * sits flush with the list's bottom border, so triggers never shift
 * position when selection changes.
 */
function TabsList({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        'inline-flex h-10 items-center gap-1 border-b border-line text-fg-muted',
        className,
      )}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        // Sized to overlap the list's bottom border by 1px so the active
        // underline replaces (not adds to) the muted base line — that's
        // what eliminates the layout shift the old pill style had.
        'relative -mb-px inline-flex h-10 items-center justify-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium text-fg-muted transition-[color,border-color] hover:text-fg focus-visible:outline-none focus-visible:text-fg',
        'data-[state=active]:border-accent-400 data-[state=active]:text-fg',
        className,
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn('outline-none', className)} {...props} />
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
