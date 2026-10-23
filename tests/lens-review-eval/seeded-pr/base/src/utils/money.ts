export function formatPrice(cents: number, currency = 'USD'): string {
  const amount = cents / 100
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
}
