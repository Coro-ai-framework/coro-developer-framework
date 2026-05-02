import { cn } from '../../lib/utils'

function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('animate-pulse rounded-2xl bg-white/6', className)} {...props} />
}

export { Skeleton }