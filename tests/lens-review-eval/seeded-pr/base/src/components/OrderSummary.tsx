import { Button } from '../ds'
import { formatPrice } from '../utils/money'

export function OrderSummary({ totalCents, onPay }: { totalCents: number; onPay: () => void }) {
  return (
    <section>
      <p>Total: {formatPrice(totalCents)}</p>
      <Button onClick={onPay}>Pay</Button>
    </section>
  )
}
