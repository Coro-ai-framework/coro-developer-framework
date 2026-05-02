import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400/60 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-accent-500 text-white shadow-[0_10px_24px_-20px_rgba(97,114,255,0.85)] hover:bg-accent-400',
        secondary:
          'bg-overlay text-fg ring-1 ring-line-strong hover:bg-panel-raised',
        ghost: 'text-fg-muted hover:bg-overlay hover:text-fg',
        danger: 'bg-danger-500/90 text-white hover:bg-danger-500',
        success: 'bg-success-500/90 text-white hover:bg-success-500',
        outline:
          'bg-transparent text-fg ring-1 ring-line-strong hover:bg-overlay',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-10 px-4',
        lg: 'h-11 px-5',
        icon: 'size-10',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, asChild = false, ...props },
  ref,
) {
  const Component = asChild ? Slot : 'button'

  return (
    <Component
      className={cn(buttonVariants({ variant, size }), className)}
      ref={ref}
      {...props}
    />
  )
})

export { Button, buttonVariants }
