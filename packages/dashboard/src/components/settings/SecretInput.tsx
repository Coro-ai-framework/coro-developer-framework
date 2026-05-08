import { forwardRef, useState, type ComponentProps } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '../ui/input'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

type InputProps = ComponentProps<typeof Input>

interface SecretInputProps extends Omit<InputProps, 'type'> {
  /** Visible by default? Defaults to false. */
  defaultRevealed?: boolean
}

/**
 * Password-style input with a show/hide toggle. Used everywhere a
 * credential is collected so the user can verify a paste without
 * re-typing it.
 */
const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(function SecretInput(
  { defaultRevealed = false, className, ...rest },
  ref,
) {
  const [revealed, setRevealed] = useState(defaultRevealed)
  return (
    <div className="relative">
      <Input
        ref={ref}
        type={revealed ? 'text' : 'password'}
        className={cn('pr-11', className)}
        autoComplete="off"
        spellCheck={false}
        {...rest}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => setRevealed(value => !value)}
        className="absolute right-1 top-1/2 size-8 -translate-y-1/2 text-fg-subtle hover:text-fg"
        aria-label={revealed ? 'Hide secret' : 'Show secret'}
        tabIndex={-1}
      >
        {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </Button>
    </div>
  )
})

export default SecretInput
