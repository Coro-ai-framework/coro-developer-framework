import {
  ClipboardCheck,
  ClipboardList,
  FileJson2,
  FilePenLine,
  FileSearch,
  FileText,
  GitPullRequest,
  Link2,
  type LucideIcon,
} from 'lucide-react'
import { artifactCategory, type ArtifactCategory } from '../../lib/job-detail-presentation'

const CATEGORY_ICON: Record<ArtifactCategory, LucideIcon> = {
  plan: ClipboardList,
  spec: FilePenLine,
  report: ClipboardCheck,
  analysis: FileSearch,
  'pull-request': GitPullRequest,
  link: Link2,
  markdown: FileText,
  data: FileJson2,
}

export function ArtifactKindIcon({
  kind,
  className = 'size-4',
}: {
  kind: string
  className?: string
}) {
  const Icon = CATEGORY_ICON[artifactCategory(kind)]
  return <Icon className={className} aria-hidden />
}
