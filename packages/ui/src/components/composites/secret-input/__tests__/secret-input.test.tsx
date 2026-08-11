// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'

import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeAll, describe, expect, it } from 'vitest'

import { SecretInput } from '../index'

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any
})

describe('SecretInput', () => {
  it('toggles a credential between masked and visible text', async () => {
    const user = userEvent.setup()
    render(
      <SecretInput
        aria-label="Credential"
        value="secret-value"
        readOnly
        showLabel="Show credential"
        hideLabel="Hide credential"
      />
    )

    const input = screen.getByLabelText('Credential')
    const showButton = screen.getByRole('button', { name: 'Show credential' })
    expect(input).toHaveAttribute('type', 'password')
    expect(showButton.querySelector('.lucide-eye')).toBeInTheDocument()

    await user.click(showButton)
    expect(input).toHaveAttribute('type', 'text')
    const hideButton = screen.getByRole('button', { name: 'Hide credential' })
    expect(hideButton.querySelector('.lucide-eye-off')).toBeInTheDocument()

    await user.click(hideButton)
    expect(input).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'Show credential' }).querySelector('.lucide-eye')).toBeInTheDocument()
  })

  it('disables both the input and visibility toggle', () => {
    render(
      <SecretInput
        aria-label="Credential"
        value="secret-value"
        readOnly
        disabled
        showLabel="Show credential"
        hideLabel="Hide credential"
      />
    )

    expect(screen.getByLabelText('Credential')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Show credential' })).toBeDisabled()
  })

  it('forwards its ref to the input element', () => {
    let inputElement: HTMLInputElement | null = null
    render(
      <SecretInput
        ref={(element) => {
          inputElement = element
        }}
        aria-label="Credential"
        showLabel="Show credential"
        hideLabel="Hide credential"
      />
    )

    expect(inputElement).toBe(screen.getByLabelText('Credential'))
  })
})
