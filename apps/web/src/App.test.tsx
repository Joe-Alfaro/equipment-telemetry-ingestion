import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { App } from './App'

describe('App (smoke)', () => {
  it('renders the shell', () => {
    render(<App />)

    expect(
      screen.getByRole('heading', { level: 1, name: 'Equipment telemetry' }),
    ).toBeInTheDocument()
  })
})
