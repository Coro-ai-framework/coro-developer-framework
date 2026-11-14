import { useParams } from 'react-router-dom'
import ReviewView from '../components/reviews/review-view'

export default function ReviewDetail() {
  const { id } = useParams<{ id: string }>()
  if (!id) return null
  return <ReviewView key={id} id={id} variant="page" />
}
