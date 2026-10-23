import type { ReactNode } from 'react'
import { colors } from './tokens'

type ButtonProps = {
  children: ReactNode
  onClick: () => void
  variant?: 'primary' | 'danger'
}

export function Button({ children, onClick, variant = 'primary' }: ButtonProps) {
  return (
    <button type="button" style={{ color: colors[variant] }} onClick={onClick}>
      {children}
    </button>
  )
}
