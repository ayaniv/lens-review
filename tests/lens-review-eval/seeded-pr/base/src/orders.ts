import { db } from './db'

export type Order = { id: string; customerId: string; totalCents: number }

export async function getOrder(id: string) {
  const [order] = await db.query('SELECT * FROM orders WHERE id = $1', [id])
  return order
}
