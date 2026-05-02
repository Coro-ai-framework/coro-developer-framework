import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-indigo-500 text-white shadow-[0_12px_30px_-18px_rgba(99,102,241,0.95)] hover:bg-indigo-400',
        secondary: 'bg-white/6 text-slate-100 ring-1 ring-white/10 hover:bg-white/10',
        ghost: 'text-slate-300 hover:bg-white/6 hover:text-white',
        danger: 'bg-rose-500/90 text-white hover:bg-rose-400',
        success: 'bg-emerald-500/90 text-white hover:bg-emerald-400',
        outline: 'bg-transparent text-slate-200 ring-1 ring-white/14 hover:bg-white/6',
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