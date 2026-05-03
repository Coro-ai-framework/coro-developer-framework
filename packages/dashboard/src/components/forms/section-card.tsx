import type { ReactNode } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../ui/card'
import { cn } from '../../lib/utils'

interface SectionCardProps {
  title: string
  description?: string
  action?: ReactNode
  className?: string
  children: ReactNode
}

export default function SectionCard({ title, description, action, className, children }: SectionCardProps) {
  return (
    <Card className={className}>
      <CardHeader className={cn('gap-3 border-b border-line pb-4', action ? 'sm:flex-row sm:items-start sm:justify-between' : '')}>
        <div className="space-y-1">
          <CardTitle>{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </CardHeader>
      <CardContent className="pt-5">{children}</CardContent>
    </Card>
  )
}
